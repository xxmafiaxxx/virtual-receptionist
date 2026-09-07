import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'
import { openDentalConnection, dbError } from '../../../../lib/opendental'

export const runtime = 'nodejs'

// Write-back endpoint: after Corinne calls an insurance company, the agent
// (webhook tool) or an admin posts the eligibility result here and it is
// written into the practice's Open Dental database against the patient chart:
//   1. patient.AddrNote  — timestamped eligibility summary (always)
//   2. insverify row     — best-effort, mimics the latest existing row's shape
// Results are also logged to the practice's call history in Firestore.
//
// Auth (either):
//   - Admin dashboard: Authorization: Bearer <ID token>
//   - ElevenLabs webhook tool: x-corinne-secret header (stored on the shared
//     practices doc, or env CORINNE_TOOL_SECRET)

const PRACTICE_ID = process.env.PRACTICE_ID || 'default'
const sharedDoc = () => adminDb.doc(`practices/${PRACTICE_ID}`)

const str = (v, max = 300) => String(v ?? '').trim().slice(0, max)

async function resolveCaller(request) {
  const secretHeader = request.headers.get('x-corinne-secret') || ''
  if (secretHeader) {
    const sharedSnap = await sharedDoc().get()
    const data = sharedSnap.exists ? sharedSnap.data() : {}
    const expected = process.env.CORINNE_TOOL_SECRET || data.toolSecret || ''
    if (!expected || secretHeader.length !== expected.length ||
        secretHeader !== expected) return { error: 'Invalid tool secret.', status: 401 }
    if (!data.ownerUid) return { error: 'Run a practice database sync first so the account with connector credentials is known.', status: 409 }
    return { uid: data.ownerUid, via: 'agent' }
  }
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) return { error: 'Unauthorized', status: 401 }
  const user = await adminAuth.verifyIdToken(v.slice(7), true)
  return { uid: user.uid, via: 'admin' }
}

export async function POST(request) {
  try {
    const caller = await resolveCaller(request)
    if (caller.error) return NextResponse.json({ error: caller.error }, { status: caller.status })

    const body = await request.json().catch(() => ({}))
    const patientId = parseInt(body.patientId ?? body.patient_id, 10)
    if (!Number.isInteger(patientId) || patientId <= 0) {
      return NextResponse.json({ error: 'A valid patientId (Open Dental PatNum) is required.' }, { status: 400 })
    }

    const opened = await openDentalConnection(caller.uid)
    if (opened.error) return NextResponse.json({ error: opened.error }, { status: opened.status })
    const conn = opened.conn

    const written = { patientNote: false, insverify: false }
    let insverifyReason = ''
    try {
      // accept both the agent tool's snake_case params and admin camelCase
      const pick = (...keys) => {
        for (const k of keys) {
          if (body[k] !== undefined && String(body[k]).trim() !== '') return body[k]
        }
        return ''
      }
      const fields = [
        pick('carrier_name', 'carrier') && `Carrier: ${str(pick('carrier_name', 'carrier'), 120)}`,
        pick('elect_id', 'electId') && `Payer ID: ${str(pick('elect_id', 'electId'), 20)}`,
        pick('plan_number', 'planNum') && `Plan #: ${str(pick('plan_number', 'planNum'), 20)}`,
        pick('group_number', 'groupNum') && `Group #: ${str(pick('group_number', 'groupNum'), 40)}`,
        pick('member_id', 'memberId') && `Member ID: ${str(pick('member_id', 'memberId'), 60)}`,
        pick('plan_status', 'planStatus') && `Status: ${str(pick('plan_status', 'planStatus'), 60)}`,
        pick('effective_date', 'effectiveDate') && `Effective: ${str(pick('effective_date', 'effectiveDate'), 30)}`,
        pick('annual_max', 'annualMax') && `Annual Max: ${str(pick('annual_max', 'annualMax'), 40)}`,
        pick('deductible') && `Deductible: ${str(pick('deductible'), 40)}`,
        pick('deductible_remaining', 'deductibleRemaining') && `Deductible remaining: ${str(pick('deductible_remaining', 'deductibleRemaining'), 40)}`,
        pick('verification_ref', 'verificationRef') && `Ref: ${str(pick('verification_ref', 'verificationRef'), 120)}`,
        pick('result_notes', 'notes') && `Notes: ${str(pick('result_notes', 'notes'), 800)}`,
      ].filter(Boolean)
      if (!fields.length) {
        return NextResponse.json({ error: 'Nothing to record — include at least one result field (carrier, status, notes, ...).' }, { status: 400 })
      }
      const stamp = new Date().toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
      const entry = `[${stamp}] Corinne (AI) verified insurance — ${fields.join(' | ')}`

      const [[pat]] = await conn.query('SELECT AddrNote FROM patient WHERE PatNum = ?', [patientId])
      if (!pat) return NextResponse.json({ error: 'Patient not found in the database.' }, { status: 404 })
      const nextNote = (pat.AddrNote ? String(pat.AddrNote).replace(/\s+$/, '') + '\n' : '') + entry
      await conn.query('UPDATE patient SET AddrNote = ? WHERE PatNum = ?', [nextNote, patientId])
      written.patientNote = true

      // Best-effort Insurance Verification row: only when an existing row can be
      // mimicked (OD requires every column NOT NULL with practice-specific
      // UserNum/VerifyType/DefNum semantics) and a plan number is given.
      const planNumRaw = pick('plan_number', 'planNum')
      if (planNumRaw) {
        try {
          const [vt] = await conn.query('SHOW TABLES LIKE "insverify"')
          if (vt.length) {
            const [last] = await conn.query('SELECT UserNum, VerifyType, DefNum, HoursAvailableForVerification FROM insverify ORDER BY InsVerifyNum DESC LIMIT 1')
            if (last.length) {
              const sec = randomBytes(16).toString('hex')
              await conn.query(
                `INSERT INTO insverify
                  (DateLastVerified, UserNum, VerifyType, FKey, DefNum, Note, DateLastAssigned, DateTimeEntry, HoursAvailableForVerification, SecDateTEdit, SecurityHash)
                 VALUES (NOW(), ?, ?, ?, ?, ?, NOW(), NOW(), ?, NOW(), ?)`,
                [last[0].UserNum, last[0].VerifyType, Number(planNumRaw), last[0].DefNum, entry, last[0].HoursAvailableForVerification || 0, sec],
              )
              written.insverify = true
            } else insverifyReason = 'insverify table is empty; skipped to avoid writing invalid verification defaults'
          } else insverifyReason = 'insverify table not present in this Open Dental database'
        } catch (e) {
          insverifyReason = 'insverify insert skipped: ' + String(e.message || '').slice(0, 140)
        }
      } else insverifyReason = 'no planNum provided; skipped'
    } finally {
      await conn.end().catch(() => {})
    }

    // Firestore log: attach to the call that produced this result when possible
    try {
      const history = adminDb.collection(`users/${caller.uid}/call-history`)
      if (body.conversationId) {
        const match = await history.where('conversationId', '==', String(body.conversationId)).limit(1).get()
        if (!match.empty) {
          await match.docs[0].ref.update({ eligibilityResult: body, resultWrittenAt: new Date(), written })
        }
      }
      await history.add({
        patientId, purpose: 'insurance-result', carrier: str(body.carrier, 120) || '',
        conversationId: str(body.conversationId, 120) || null, result: str(body.notes || body.planStatus || '', 800),
        createdAt: new Date(), status: 'result-recorded', written,
      })
    } catch {}

    return NextResponse.json({ ok: true, written, patientId, insverifyReason: written.insverify ? null : insverifyReason })
  } catch (e) {
    if (e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')) {
      return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    }
    return NextResponse.json({ error: e?.sqlMessage || dbError(e) || 'Could not write the result to the database.' }, { status: 500 })
  }
}
