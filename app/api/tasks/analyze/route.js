import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'
import { openDentalConnection, dbError } from '../../../../lib/opendental'

export const runtime = 'nodejs'

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

const SENTINEL = '0001-01-01'
const isoToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const shiftISO = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d + days)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}
const shortDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US')

// Per-kind generation caps — the worklist bulk POST allows 300 at a time.
const CAPS = {
  appointment_confirmation: 75,
  insurance_verification: 75,
  continuing_care: 60,
  treatment_followup: 60,
  insurance_missing: 30,
}

// Pull the practice's live Open Dental data and build a proposed agent worklist:
// appointment confirmations, insurance verification ahead of visits, overdue
// recalls (continuing care), treatment-plan follow-ups, and missing coverage.
// Open tasks in Firestore (same kind + patient) are skipped as duplicates.
export async function POST(request) {
  try {
    const user = await userFrom(request)
    const opened = await openDentalConnection(user.uid)
    if (opened.error) return NextResponse.json({ error: opened.error }, { status: opened.status })
    const { conn, systemName } = opened
    try {
      const today = isoToday()
      const [pats] = await conn.query(
        `SELECT p.PatNum AS id, TRIM(CONCAT(p.FName, ' ', p.LName)) AS name, p.Guarantor AS guarantor,
            COALESCE(NULLIF(p.WirelessPhone, ''), NULLIF(p.HmPhone, ''), NULLIF(p.WkPhone, '')) AS phone
           FROM patient p WHERE p.PatStatus IN (0, 1, 2)`,
      )
      const [appts] = await conn.query(
        `SELECT a.PatNum AS patNum, DATE_FORMAT(a.AptDateTime, '%Y-%m-%d') AS apptDate,
            DATE_FORMAT(a.AptDateTime, '%l:%i %p') AS apptTime, NULLIF(a.ProcDescript, '') AS procs,
            COALESCE(d.ItemName, 'Unknown') AS confirmedName
           FROM appointment a
           LEFT JOIN definition d ON d.DefNum = a.Confirmed AND d.Category = 2
           WHERE a.AptStatus = 1 AND a.AptDateTime >= NOW() AND a.AptDateTime < NOW() + INTERVAL 30 DAY
           ORDER BY a.AptDateTime ASC`,
      )
      const [nextAppts] = await conn.query(
        `SELECT PatNum AS patNum, MIN(DATE_FORMAT(AptDateTime, '%Y-%m-%d')) AS nextAppt
           FROM appointment WHERE AptStatus = 1 AND AptDateTime >= NOW() GROUP BY PatNum`,
      )
      const [insRows] = await conn.query(
        `SELECT i.Subscriber AS subscriber, GROUP_CONCAT(DISTINCT c.CarrierName SEPARATOR ', ') AS carriers,
            GROUP_CONCAT(DISTINCT i.PlanNum) AS planIds
           FROM inssub i JOIN insplan pl ON pl.PlanNum = i.PlanNum JOIN carrier c ON c.CarrierNum = pl.CarrierNum
           GROUP BY i.Subscriber`,
      )
      const [verRows] = await conn.query(
        `SELECT v.FKey AS planNum, MAX(DATE_FORMAT(v.DateLastVerified, '%Y-%m-%d')) AS lastVerified
           FROM insverify v WHERE v.VerifyType = 1 GROUP BY v.FKey`,
      )
      const [recalls] = await conn.query(
        `SELECT r.PatNum AS patNum, t.Description AS typeName,
            DATE_FORMAT(r.DateDue, '%Y-%m-%d') AS dateDue, DATE_FORMAT(r.DateScheduled, '%Y-%m-%d') AS dateScheduled
           FROM recall r LEFT JOIN recalltype t ON t.RecallTypeNum = r.RecallTypeNum
           JOIN patient p ON p.PatNum = r.PatNum AND p.PatStatus IN (0, 1, 2)
           WHERE r.IsDisabled = 0`,
      )
      const [tpRows] = await conn.query(
        `SELECT pl.PatNum AS patNum, COUNT(*) AS n, SUM(pl.ProcFee) AS total
           FROM procedurelog pl WHERE pl.ProcStatus = 1 GROUP BY pl.PatNum`,
      )

      const patientById = new Map(pats.map((p) => [p.id, p]))
      const carriersBySubscriber = new Map(insRows.map((r) => [r.subscriber, r]))
      const coverageOf = (p) => carriersBySubscriber.get(p.id) || carriersBySubscriber.get(p.guarantor) || null
      const verifiedPlan = new Map(verRows.map((r) => [r.planNum, r.lastVerified]))
      const nextApptOf = new Map(nextAppts.map((r) => [r.patNum, r.nextAppt]))
      const tpOf = new Map(tpRows.map((r) => [r.patNum, r]))

      // One proposed task per patient per kind, earliest date first.
      const found = { appointment_confirmation: [], insurance_verification: [], continuing_care: [], treatment_followup: [], insurance_missing: [] }
      const seenKindPat = new Set()

      for (const a of appts) {
        if (seenKindPat.has(`confirm:${a.patNum}`)) continue
        seenKindPat.add(`confirm:${a.patNum}`)
        found.appointment_confirmation.push({
          kind: 'appointment_confirmation',
          patientId: a.patNum,
          patientName: patientById.get(a.patNum)?.name || `(patient ${a.patNum})`,
          phone: patientById.get(a.patNum)?.phone || '',
          title: `Confirm appointment on ${shortDate(a.apptDate)}`,
          dueDate: a.apptDate,
          notes: `${a.apptDate === today ? 'Today' : shortDate(a.apptDate)} at ${a.apptTime} — ${a.procs || 'appointment'} · currently "${a.confirmedName}".`,
        })
        if (seenKindPat.has(`insver:${a.patNum}`)) continue
        seenKindPat.add(`insver:${a.patNum}`)
        const cov = coverageOf(patientById.get(a.patNum) || {})
        const planIds = cov ? String(cov.planIds).split(',').map(Number) : []
        const verified = planIds.some((pn) => { const lv = verifiedPlan.get(pn); return lv && lv !== SENTINEL && lv >= shiftISO(today, -180) })
        if (cov && !verified) {
          found.insurance_verification.push({
            kind: 'insurance_verification',
            patientId: a.patNum,
            patientName: patientById.get(a.patNum)?.name || `(patient ${a.patNum})`,
            phone: patientById.get(a.patNum)?.phone || '',
            title: `Verify insurance benefits before ${shortDate(a.apptDate)}`,
            dueDate: a.apptDate === today ? today : shiftISO(a.apptDate, -1),
            notes: `${cov.carriers} · appointment ${shortDate(a.apptDate)} at ${a.apptTime}. Confirm eligibility, annual max, deductible, and coverage for the planned work.`,
          })
        }
        if (!cov && seenKindPat.has(`insmiss:${a.patNum}`) === false) {
          seenKindPat.add(`insmiss:${a.patNum}`)
          found.insurance_missing.push({
            kind: 'insurance_missing',
            patientId: a.patNum,
            patientName: patientById.get(a.patNum)?.name || `(patient ${a.patNum})`,
            phone: patientById.get(a.patNum)?.phone || '',
            title: 'Collect insurance information',
            dueDate: a.apptDate === today ? today : shiftISO(a.apptDate, -1),
            notes: `Upcoming appointment ${shortDate(a.apptDate)} at ${a.apptTime}, but no coverage is on file.`,
          })
        }
      }

      for (const r of recalls) {
        if (!r.dateDue || r.dateDue === SENTINEL || r.dateScheduled !== SENTINEL) continue
        if (seenKindPat.has(`recall:${r.patNum}`)) continue
        seenKindPat.add(`recall:${r.patNum}`)
        const p = patientById.get(r.patNum)
        if (!p) continue
        const overdueDays = Math.max(Math.floor((new Date(today) - new Date(r.dateDue)) / 86400000), 0)
        const nextAppt = nextApptOf.get(r.patNum)
        const typeName = r.typeName ? `${r.typeName} recall` : 'recall'
        found.continuing_care.push({
          kind: 'continuing_care',
          patientId: r.patNum,
          patientName: p.name,
          phone: p.phone || '',
          title: `Schedule continuing care visit (${r.typeName === 'Prophy' ? 'cleaning & exam' : (r.typeName || 'hygiene').toLowerCase()})`,
          dueDate: overdueDays ? today : r.dateDue,
          notes: `${typeName} due ${r.dateDue === SENTINEL ? '—' : shortDate(r.dateDue)}${overdueDays ? ` · overdue ${overdueDays > 365 ? `${Math.floor(overdueDays / 365)} yr` : `${overdueDays} days`}` : ''}${nextAppt ? ` · next visit ${shortDate(nextAppt)} — pair the recall with it` : ''}.`,
        })
      }

      for (const [patNum, tp] of tpOf) {
        if (seenKindPat.has(`tp:${patNum}`)) continue
        seenKindPat.add(`tp:${patNum}`)
        const p = patientById.get(patNum)
        if (!p) continue
        const nextAppt = nextApptOf.get(patNum)
        found.treatment_followup.push({
          kind: 'treatment_followup',
          patientId: patNum,
          patientName: p.name,
          phone: p.phone || '',
          title: 'Follow up on treatment plan',
          dueDate: '',
          notes: `${tp.n} treatment-planned procedure${tp.n === 1 ? '' : 's'} · est. ${money(tp.total)}${nextAppt ? ` · next visit ${shortDate(nextAppt)}` : ''}. Check in and offer to schedule.`,
        })
      }

      const priorized = {
        appointment_confirmation: found.appointment_confirmation.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
        insurance_verification: found.insurance_verification.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
        continuing_care: found.continuing_care.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
        treatment_followup: found.treatment_followup.sort((a, b) => (tpOf.get(b.patientId)?.total || 0) - (tpOf.get(a.patientId)?.total || 0)),
        insurance_missing: found.insurance_missing.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
      }

      const openSnap = await adminDb.collection(`users/${user.uid}/tasks`).where('status', '==', 'open').get()
      const existingKeys = new Set(openSnap.docs.map((d) => `${d.data().kind || ''}:${d.data().patientId || ''}`).filter((k) => !k.endsWith(':')))

      let skippedNoPhone = 0
      let duplicates = 0
      const tasks = []
      for (const [kind, list] of Object.entries(priorized)) {
        for (const task of list) {
          if (existingKeys.has(`${kind}:${task.patientId}`)) { duplicates++; continue }
          if (!task.phone) { skippedNoPhone++; continue }
          if (tasks.length >= 300 || tasks.filter((t) => t.kind === kind).length >= CAPS[kind]) continue
          tasks.push(task)
        }
      }

      return NextResponse.json({
        source: systemName,
        analyzedAt: new Date().toISOString(),
        found: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length])),
        duplicates,
        skippedNoPhone,
        tasks,
      })
    } finally {
      await conn.end().catch(() => {})
    }
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: dbError(e) }, { status: 500 })
  }
}
