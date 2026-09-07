import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'

export const runtime = 'nodejs'

// Returns everything needed to register Corinne's write-back webhook tool on
// the ElevenLabs agent: the endpoint URL, the shared secret (created on first
// call and stored on the shared practice doc), and the ready-to-paste tool JSON.
const PRACTICE_ID = process.env.PRACTICE_ID || 'default'
const sharedDoc = () => adminDb.doc(`practices/${PRACTICE_ID}`)

const toolJson = (url, secret) => ({
  name: 'record_eligibility_result',
  type: 'webhook',
  description:
    'Call this tool at the end of every insurance verification call to record the verified benefits back into the dental practice database. Fill every field you confirmed with the insurance representative; leave fields empty that were not confirmed.',
  method: 'POST',
  url,
  headers: { 'x-corinne-secret': secret },
  body_params: {
    patient_id: { type: 'string', value: '{{patient_id}}', description: 'The Open Dental patient number this call was about. Always send the dynamic value.' },
    carrier_name: { type: 'string', description: 'Name of the insurance company called.' },
    plan_number: { type: 'string', description: 'Plan number confirmed by the representative.' },
    group_number: { type: 'string', description: 'Group policy number confirmed by the representative.' },
    member_id: { type: 'string', description: 'Patient member ID on file with the insurer.' },
    plan_status: { type: 'string', description: 'Whether coverage is active, inactive, terminated, etc.' },
    effective_date: { type: 'string', description: 'Coverage effective date if given.' },
    annual_max: { type: 'string', description: 'Annual maximum benefit, e.g. "$1500".' },
    deductible: { type: 'string', description: 'Total deductible, e.g. "$50".' },
    deductible_remaining: { type: 'string', description: 'Deductible amount still remaining.' },
    verification_ref: { type: 'string', description: 'Call reference number the representative provided.' },
    result_notes: { type: 'string', description: 'Any other details from the call worth recording.' },
  },
})

export async function GET(request) {
  try {
    const v = request.headers.get('authorization') || ''
    if (!v.startsWith('Bearer ')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const user = await adminAuth.verifyIdToken(v.slice(7), true)

    const ref = sharedDoc()
    const snap = await ref.get()
    let secret = snap.exists ? snap.data()?.toolSecret : ''
    if (!secret) {
      secret = randomBytes(24).toString('hex')
      await ref.set({ toolSecret: secret, updatedAt: new Date(), ownerUid: user.uid }, { merge: true })
    }
    const url = (process.env.APP_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '') + '/api/insurance/record'
    return NextResponse.json({ url, secret, tool: toolJson(url, secret) })
  } catch (e) {
    const authFail = String(e?.code || '').startsWith('auth/')
    return NextResponse.json({ error: authFail ? 'Your session expired. Sign in again.' : 'Could not build the tool configuration.' }, { status: authFail ? 401 : 500 })
  }
}
