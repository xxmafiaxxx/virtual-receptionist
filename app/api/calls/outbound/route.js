import { NextResponse } from 'next/server'
import { adminAuth } from '../../../../lib/firebase-admin'
import { placeOutboundCall } from '../../../../lib/outbound-call'

export const runtime = 'nodejs'

async function authenticate(request) {
  const header = request.headers.get('authorization') || ''
  if (!header.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(header.slice(7), true)
}

export async function POST(request) {
  try {
    const user = await authenticate(request)
    const { patient, purpose, script, prompt } = await request.json()
    if (!patient?.phone || !patient?.name || !purpose || !script || !prompt) {
      return NextResponse.json({ error: 'Patient, purpose, script, and prompt are required.' }, { status: 400 })
    }
    const result = await placeOutboundCall(user.uid, { patient, purpose, script, prompt })
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status })
    return NextResponse.json({ success: true, conversationId: result.conversationId })
  } catch (error) {
    if (error?.message === 'Unauthorized' || String(error?.code || '').startsWith('auth/')) {
      return NextResponse.json({ error: 'Your login session expired. Sign in again before placing a call.', code: 'AUTH_REQUIRED' }, { status: 401 })
    }
    console.error('Outbound call failed', { code: error?.code, name: error?.name })
    return NextResponse.json({ error: 'The call failed before reaching ElevenLabs. Check server logs for the error code.', code: 'CALL_START_FAILED' }, { status: 500 })
  }
}
