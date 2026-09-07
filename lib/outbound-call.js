import { adminDb } from './firebase-admin'
import { decryptSecret } from './secret-crypto'
import { getPracticeSettings } from './practice-settings'

// Shared outbound-call placement used by both the single-call route (authenticated)
// and the campaign worker (server-to-server). Reads the practice's encrypted ElevenLabs
// credentials from Firestore by uid and returns a uniform result object.
export async function placeOutboundCall(uid, { patient, purpose, script, prompt }) {
  const snapshot = await adminDb.doc(`users/${uid}/private/integration-secrets`).get()
  const stored = snapshot.data()?.secrets || {}

  let apiKey, agentId, phoneNumberId
  try {
    apiKey = decryptSecret(stored.elevenlabs)
    agentId = decryptSecret(stored.elevenlabsAgentId) || process.env.ELEVENLABS_AGENT_ID
    phoneNumberId = decryptSecret(stored.elevenlabsPhoneNumberId) || process.env.ELEVENLABS_PHONE_NUMBER_ID
  } catch {
    return { ok: false, status: 409, code: 'DECRYPT_FAILED', error: 'Saved API keys can no longer be decrypted. Re-enter them under API keys.' }
  }

  const missing = [
    !apiKey && 'ElevenLabs API key',
    !agentId && 'ElevenLabs agent ID',
    !phoneNumberId && 'ElevenLabs phone-number ID',
  ].filter(Boolean)
  if (missing.length) {
    return { ok: false, status: 409, code: 'ELEVENLABS_SETUP_INCOMPLETE', error: `Call setup is incomplete. Add ${missing.join(', ')} under API keys.` }
  }

  const phone = String(patient.phone).replace(/[^+\d]/g, '')
  if (!/^\+?[1-9]\d{7,14}$/.test(phone)) {
    return { ok: false, status: 400, error: 'Enter a valid E.164 phone number.' }
  }

  let response
  let practiceName = ''
  let practicePhone = ''
  try {
    const practice = await getPracticeSettings(uid)
    practiceName = practice.practice.name
    practicePhone = practice.practice.phone
  } catch {}

  try {
    response = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({
        agent_id: agentId,
        agent_phone_number_id: phoneNumberId,
        to_number: phone.startsWith('+') ? phone : `+${phone}`,
        conversation_initiation_client_data: {
          dynamic_variables: {
            patient_name: patient.name,
            call_purpose: purpose,
            practice_name: practiceName,
            practice_phone: practicePhone,
          },
          conversation_config_override: { agent: { first_message: script, prompt: { prompt } } },
        },
      }),
    })
  } catch {
    return { ok: false, status: 502, code: 'ELEVENLABS_UNREACHABLE', error: 'The server could not reach ElevenLabs.' }
  }

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    return { ok: false, status: response.status, error: data.detail?.message || data.detail || data.message || 'ElevenLabs rejected the call.' }
  }

  await adminDb.collection(`users/${uid}/call-history`).add({
    patientName: patient.name, phone, purpose, conversationId: data.conversation_id || null, createdAt: new Date(), status: 'initiated',
  })
  return { ok: true, status: 200, conversationId: data.conversation_id || null }
}
