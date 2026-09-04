import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'
import { decryptSecret } from '../../../../lib/secret-crypto'

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
    const phone = String(patient.phone).replace(/[^+\d]/g, '')
    if (!/^\+?[1-9]\d{7,14}$/.test(phone)) return NextResponse.json({ error: 'Enter a valid E.164 phone number.' }, { status: 400 })

    const snapshot = await adminDb.doc(`users/${user.uid}/private/integration-secrets`).get()
    const stored = snapshot.data()?.secrets || {}
    const apiKey = decryptSecret(stored.elevenlabs)
    const agentId = decryptSecret(stored.elevenlabsAgentId) || process.env.ELEVENLABS_AGENT_ID
    const phoneNumberId = decryptSecret(stored.elevenlabsPhoneNumberId) || process.env.ELEVENLABS_PHONE_NUMBER_ID
    if (!apiKey || !agentId || !phoneNumberId) {
      return NextResponse.json({ error: 'Add your ElevenLabs API key, agent ID, and phone-number ID under API keys.' }, { status: 409 })
    }

    const response = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({
        agent_id: agentId,
        agent_phone_number_id: phoneNumberId,
        to_number: phone.startsWith('+') ? phone : `+${phone}`,
        conversation_initiation_client_data: {
          dynamic_variables: { patient_name: patient.name, call_purpose: purpose },
          conversation_config_override: { agent: { first_message: script, prompt: { prompt } } },
        },
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) return NextResponse.json({ error: data.detail?.message || data.detail || data.message || 'ElevenLabs rejected the call.' }, { status: response.status })
    await adminDb.collection(`users/${user.uid}/call-history`).add({ patientName: patient.name, phone, purpose, conversationId: data.conversation_id || null, createdAt: new Date(), status: 'initiated' })
    return NextResponse.json({ success: true, conversationId: data.conversation_id || null })
  } catch (error) {
    const status = error?.message === 'Unauthorized' ? 401 : 500
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'The call could not be started.' }, { status })
  }
}
