import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'
import { openDentalConnection, dbError } from '../../../../lib/opendental'

export const runtime = 'nodejs'

// Pull the practice's real insurance payers from the connected Open Dental
// database: carrier phone numbers (to call), electronic payer IDs, and every
// active plan's plan number + group number + group name. Stored server-side so
// the panel (and the agent) read the same payer list across browsers.
async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

const fmtPhone = (v) => {
  const d = String(v || '').replace(/\D/g, '')
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
  return String(v || '').trim()
}

// Shared across all admin users of the practice: whoever pulls, everyone reads
// the same payer list. PRACTICE_ID is a forward-compat seam for multi-practice.
const PRACTICE_ID = process.env.PRACTICE_ID || 'default'
const sharedDoc = () => adminDb.doc(`practices/${PRACTICE_ID}`)
const legacyDoc = (uid) => adminDb.doc(`users/${uid}/private/insurance-payers`)

async function readPayers(uid) {
  const sharedSnap = await sharedDoc().get()
  let data = sharedSnap.exists ? { payers: sharedSnap.data()?.payers || [], pulledAt: sharedSnap.data()?.pulledAt || null } : null
  if (!data?.payers?.length) {
    const legacySnap = await legacyDoc(uid).get().catch(() => null)
    const legacy = legacySnap?.exists ? legacySnap.data() : null
    if (legacy?.payers?.length) {
      data = { payers: legacy.payers, pulledAt: legacy.pulledAt || null }
      await sharedDoc().set({ payers: data.payers, pulledAt: data.pulledAt, updatedAt: new Date(), ownerUid: uid }, { merge: true })
    }
  }
  return data
}

export async function GET(request) {
  try {
    const user = await userFrom(request)
    const data = (await readPayers(user.uid)) || { payers: [], pulledAt: null }
    return NextResponse.json(data)
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not load pulled payers.' }, { status: 500 })
  }
}

export async function POST(request) {
  let conn
  try {
    const user = await userFrom(request)
    const opened = await openDentalConnection(user.uid)
    if (opened.error) return NextResponse.json({ error: opened.error }, { status: opened.status })
    conn = opened.conn
    try {
      const [carriers] = await conn.query(
        `SELECT c.CarrierNum, c.CarrierName, c.Phone, c.ElectID, COUNT(p.PlanNum) AS planCount
           FROM carrier c JOIN insplan p ON p.CarrierNum = c.CarrierNum
          WHERE c.IsHidden = 0 AND p.IsHidden = 0
          GROUP BY c.CarrierNum, c.CarrierName, c.Phone, c.ElectID
          ORDER BY planCount DESC, c.CarrierName LIMIT 100`,
      )
      if (!carriers.length) return NextResponse.json({ error: 'No insurance carriers with active plans were found in the database.' }, { status: 404 })

      const ids = carriers.map((c) => c.CarrierNum)
      const [plans] = await conn.query(
        `SELECT p.PlanNum, p.CarrierNum, p.GroupNum, p.GroupName, p.EmployerNum,
                e.EmpName AS employerName, e.Phone AS employerPhone
           FROM insplan p LEFT JOIN employer e ON e.EmployerNum = p.EmployerNum
          WHERE p.IsHidden = 0 AND p.CarrierNum IN (?) ORDER BY p.CarrierNum, p.PlanNum`,
        [ids],
      )

      const byCarrier = {}
      for (const p of plans) {
        ;(byCarrier[p.CarrierNum] = byCarrier[p.CarrierNum] || []).push({
          planNum: String(p.PlanNum),
          groupNum: String(p.GroupNum || '').trim(),
          groupName: String(p.GroupName || '').trim(),
          employerName: String(p.employerName || '').trim(),
          employerPhone: fmtPhone(p.employerPhone),
        })
      }

      const payers = carriers.map((c) => ({
        name: String(c.CarrierName || '').trim(),
        phone: fmtPhone(c.Phone),
        electId: String(c.ElectID || '').trim(),
        plans: byCarrier[c.CarrierNum] || [],
      }))
      const pulledAt = new Date()
      const planTotal = payers.reduce((n, p) => n + p.plans.length, 0)
      await sharedDoc().set({ payers, pulledAt, updatedAt: new Date(), ownerUid: user.uid }, { merge: true })
      return NextResponse.json({ ok: true, payers, pulledAt, counts: { payers: payers.length, plans: planTotal } })
    } finally {
      await conn.end().catch(() => {})
    }
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: e?.sqlMessage || dbError(e) || 'Could not pull insurance payers.' }, { status: 500 })
  }
}
