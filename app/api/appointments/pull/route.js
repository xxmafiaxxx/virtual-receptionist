import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'
import { openDentalConnection, dbError } from '../../../../lib/opendental'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

function toTimeLabel(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number)
  const h12 = ((h % 12) || 12)
  return `${h12}:${String(m).padStart(2, '0')}`
}

function shiftISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d + n)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

function resolveRange(body, searchParams) {
  const date = (body?.date || searchParams.get('date') || '').trim()
  const fromQ = (body?.from || searchParams.get('from') || '').trim()
  const toQ = (body?.to || searchParams.get('to') || '').trim()
  if (date && DATE_RE.test(date)) return { from: date, to: date }
  if (fromQ && DATE_RE.test(fromQ) && toQ && DATE_RE.test(toQ)) return { from: fromQ, to: toQ }
  if (fromQ && DATE_RE.test(fromQ)) return { from: fromQ, to: shiftISO(fromQ, 6) }
  // default: next 7 days starting today (client's viewed date if supplied via body.date, else today)
  const today = new Date()
  const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return { from: t, to: shiftISO(t, 6) }
}

async function fetchOpenDentalAppointments(conn, from, to) {
  const [rows] = await conn.query(
    `SELECT a.AptNum, a.PatNum, a.AptDateTime, a.AptStatus, a.Op, a.ProvNum, a.ProvHyg, a.ProcDescript,
            DATE_FORMAT(a.AptDateTime,'%Y-%m-%d') AS aptDate,
            DATE_FORMAT(a.AptDateTime,'%H:%i') AS aptTime24,
            p.FName, p.LName, p.WirelessPhone, p.HmPhone, p.WkPhone,
            o.OpName, o.Abbrev AS OpAbbrev,
            pr.Abbr AS ProvAbbr, pr.FName AS ProvFName, pr.LName AS ProvLName, pr.PreferredName AS ProvPreferred
       FROM appointment a
       JOIN patient p ON p.PatNum = a.PatNum
  LEFT JOIN operatory o ON o.OperatoryNum = a.Op
  LEFT JOIN provider pr ON pr.ProvNum = a.ProvNum
      WHERE a.AptStatus = 1
        AND a.AptDateTime BETWEEN ? AND ?
      ORDER BY a.AptDateTime, a.Op`,
    [`${from} 00:00:00`, `${to} 23:59:59`],
  )
  return rows
}

function shapeForFirebase(r) {
  const patientName = `${String(r.FName || '').trim()} ${String(r.LName || '').trim()}`.trim() || `Patient ${r.PatNum}`
  const phone = String(r.WirelessPhone || r.HmPhone || r.WkPhone || '').trim()
  const provider = String(r.ProvPreferred || '').trim() || `${String(r.ProvFName || '').trim()} ${String(r.ProvLName || '').trim()}`.trim() || String(r.ProvAbbr || '').trim() || ''
  // operatory must match the app's room names (stored in localStorage corinne-rooms /
  // practice operatories). Open Dental OpName is the canonical name: e.g.
  // "Dr. Brian Albert", "Tina", "Bruce", "Doctor Overflow".
  const operatory = String(r.OpName || '').trim() || String(r.OpAbbrev || '').trim() || ''
  return {
    patientName,
    phone: phone.replace(/[^+\d]/g, '') || phone,
    date: String(r.aptDate || '').trim(),
    time: toTimeLabel(r.aptTime24),
    provider,
    operatory,
    status: 'scheduled',
    openDentalAptNum: Number(r.AptNum),
    procDescript: String(r.ProcDescript || '').trim(),
    source: 'opendental',
  }
}

// Preview without writing: GET ?date=YYYY-MM-DD or ?from=&to=
export async function GET(request) {
  let conn
  try {
    const user = await userFrom(request)
    const { searchParams } = new URL(request.url)
    let body = {}
    try { body = await request.clone().json() } catch {}
    const { from, to } = resolveRange(body, searchParams)
    const opened = await openDentalConnection(user.uid)
    if (opened.error) return NextResponse.json({ error: opened.error }, { status: opened.status })
    conn = opened.conn
    const rows = await fetchOpenDentalAppointments(conn, from, to)
    const appointments = rows.map(shapeForFirebase)
    return NextResponse.json({ ok: true, from, to, count: appointments.length, appointments, source: opened.systemName })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: e?.sqlMessage || dbError(e) || 'Could not pull appointments.' }, { status: 500 })
  } finally {
    if (conn) await conn.end().catch(() => {})
  }
}

// Sync into Firebase: POST { date } or { from, to }
export async function POST(request) {
  let conn
  try {
    const user = await userFrom(request)
    const body = await request.json().catch(() => ({}))
    const { searchParams } = new URL(request.url)
    const { from, to } = resolveRange(body, searchParams)
    const opened = await openDentalConnection(user.uid)
    if (opened.error) return NextResponse.json({ error: opened.error }, { status: opened.status })
    conn = opened.conn

    const rows = await fetchOpenDentalAppointments(conn, from, to)
    const shaped = rows.map(shapeForFirebase)
    let synced = 0
    let skipped = 0

    const col = adminDb.collection(`users/${user.uid}/appointments`)

    for (const appt of shaped) {
      if (!appt.date || !appt.time || !DATE_RE.test(appt.date)) { skipped++; continue }
      // dedupe by openDentalAptNum so re-pulls do not duplicate
      const existing = await col.where('openDentalAptNum', '==', appt.openDentalAptNum).limit(1).get().catch(() => null)
      if (existing && !existing.empty) {
        const doc = existing.docs[0]
        await doc.ref.set({ ...appt, syncedAt: new Date(), updatedAt: new Date() }, { merge: true })
        synced++
      } else {
        await col.add({ ...appt, createdAt: new Date(), syncedAt: new Date() })
        synced++
      }
    }

    return NextResponse.json({ ok: true, from, to, counts: { pulled: shaped.length, synced, skipped }, source: opened.systemName })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: e?.sqlMessage || dbError(e) || 'Could not sync appointments.' }, { status: 500 })
  } finally {
    if (conn) await conn.end().catch(() => {})
  }
}
