import { adminDb } from './firebase-admin'
import { decryptSecret } from './secret-crypto'
import { getPracticeSettings } from './practice-settings'
import { openDentalConnection } from './opendental'

function buildChartNote({ patient, purpose, phone, script, conversationId, status, error }) {
  const stamp = new Date().toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  const label = String(purpose || 'call').trim()
  const preview = String(script || '').replace(/\s+/g, ' ').trim().slice(0, 140)
  const to = String(patient?.name || phone || '').trim()
  if (status === 'initiated') {
    return `[${stamp}] Corinne (AI) call — ${label} — ${to} — ${phone} — initiated${conversationId ? ` — conversation ${conversationId}` : ''}${preview ? ` — "${preview}"` : ''}`
  }
  return `[${stamp}] Corinne (AI) call — ${label} — ${to} — ${phone} — failed — ${String(error || 'unknown').slice(0, 160)}${preview ? ` — "${preview}"` : ''}`
}

async function logToOpenDental(uid, patient, purpose, phone, script, conversationId, status, error) {
  const rawId = patient?.id ?? patient?.patientId ?? patient?.patNum ?? patient?.PatNum
  const patNum = Number(rawId)
  if (!Number.isInteger(patNum) || patNum <= 0) return
  let conn
  try {
    const opened = await openDentalConnection(uid)
    if (opened.error || !opened.conn) return
    conn = opened.conn
    const entry = buildChartNote({ patient, purpose, phone, script, conversationId, status, error }).slice(0, 2000)

    // Always append to patient chart notes (patient.AddrNote), as done for insurance verification.
    try {
      const [[pat]] = await conn.query('SELECT AddrNote FROM patient WHERE PatNum = ?', [patNum])
      if (pat) {
        const nextNote = (pat.AddrNote ? String(pat.AddrNote).replace(/\s+$/, '') + '\n' : '') + entry
        await conn.query('UPDATE patient SET AddrNote = ? WHERE PatNum = ?', [nextNote, patNum])
      }
    } catch {}

    // Best-effort commlog row. Only if the table exists; insert with columns that actually exist
    // so it works across OD versions without NOT NULL violations.
    try {
      const [has] = await conn.query('SHOW TABLES LIKE "commlog"')
      if (!has.length) return
      const [cols] = await conn.query('SHOW COLUMNS FROM commlog')
      const names = new Set(cols.map((c) => c.Field))
      if (!names.has('PatNum') || !names.has('Note')) return
      // Borrow a valid UserNum from the most recent commlog row, else from userod, else 0.
      let userNum = 0
      try {
        const [last] = await conn.query('SELECT UserNum FROM commlog ORDER BY CommLogNum DESC LIMIT 1')
        if (last.length && Number.isFinite(Number(last[0].UserNum))) userNum = Number(last[0].UserNum)
        else {
          const [u] = await conn.query('SELECT UserNum FROM userod ORDER BY UserNum LIMIT 1')
          if (u.length) userNum = Number(u[0].UserNum) || 0
        }
      } catch {}
      const colList = ['PatNum', 'CommDateTime', 'Note']
      const valList = ['?', 'NOW()', '?']
      const params = [patNum, entry]
      if (names.has('CommType')) { colList.push('CommType'); valList.push('?'); params.push(0) }
      if (names.has('UserNum')) { colList.push('UserNum'); valList.push('?'); params.push(userNum) }
      if (names.has('Mode_')) { colList.push('Mode_'); valList.push('?'); params.push(0) }
      if (names.has('SentOrReceived')) { colList.push('SentOrReceived'); valList.push('?'); params.push(1) }
      // Some OD forks add SecDateTEdit / SecurityHash
      if (names.has('SecDateTEdit')) { colList.push('SecDateTEdit'); valList.push('NOW()') }
      await conn.query(`INSERT INTO commlog (${colList.join(', ')}) VALUES (${valList.join(', ')})`, params)
    } catch {}
  } catch {} finally {
    try { await conn?.end?.() } catch {}
  }
}

async function logToFirestore(uid, patient, purpose, phone, script, prompt, conversationId, status, error) {
  try {
    const rawId = patient?.id ?? patient?.patientId ?? patient?.patNum ?? null
    const patNum = rawId != null && String(rawId).trim() !== '' ? Number(rawId) : null
    await adminDb.collection(`users/${uid}/call-history`).add({
      patientId: Number.isInteger(patNum) && patNum > 0 ? patNum : null,
      patientName: String(patient?.name || '').slice(0, 200),
      phone: String(phone || '').slice(0, 30),
      email: String(patient?.email || '').slice(0, 200),
      purpose: String(purpose || '').slice(0, 80),
      script: String(script || '').slice(0, 4000),
      prompt: String(prompt || '').slice(0, 8000),
      conversationId: conversationId || null,
      status,
      error: error ? String(error).slice(0, 800) : null,
      createdAt: new Date(),
    })
  } catch {}
}

// Shared outbound-call placement used by both the single-call route (authenticated)
// and the campaign worker (server-to-server). Reads the practice's encrypted ElevenLabs
// credentials from Firestore by uid and returns a uniform result object.
// Every attempt is logged to Firestore call-history and, when a patient PatNum is
// known, appended to the live Open Dental chart (patient.AddrNote + commlog).
export async function placeOutboundCall(uid, { patient, purpose, script, prompt }) {
  const snapshot = await adminDb.doc(`users/${uid}/private/integration-secrets`).get()
  const stored = snapshot.data()?.secrets || {}

  let apiKey, agentId, phoneNumberId
  try {
    apiKey = decryptSecret(stored.elevenlabs)
    agentId = decryptSecret(stored.elevenlabsAgentId) || process.env.ELEVENLABS_AGENT_ID
    phoneNumberId = decryptSecret(stored.elevenlabsPhoneNumberId) || process.env.ELEVENLABS_PHONE_NUMBER_ID
  } catch {
    const error = 'Saved API keys can no longer be decrypted. Re-enter them under API keys.'
    await logToFirestore(uid, patient, purpose, String(patient?.phone || ''), script, prompt, null, 'failed', error)
    return { ok: false, status: 409, code: 'DECRYPT_FAILED', error }
  }

  const missing = [
    !apiKey && 'ElevenLabs API key',
    !agentId && 'ElevenLabs agent ID',
    !phoneNumberId && 'ElevenLabs phone-number ID',
  ].filter(Boolean)
  if (missing.length) {
    const error = `Call setup is incomplete. Add ${missing.join(', ')} under API keys.`
    await logToFirestore(uid, patient, purpose, String(patient?.phone || ''), script, prompt, null, 'failed', error)
    return { ok: false, status: 409, code: 'ELEVENLABS_SETUP_INCOMPLETE', error }
  }

  const phone = String(patient.phone).replace(/[^+\d]/g, '')
  if (!/^\+?[1-9]\d{7,14}$/.test(phone)) {
    const error = 'Enter a valid E.164 phone number.'
    await logToFirestore(uid, patient, purpose, phone || String(patient?.phone || ''), script, prompt, null, 'failed', error)
    return { ok: false, status: 400, error }
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
            patient_id: String(patient.id ?? patient.patientId ?? ''),
            call_purpose: purpose,
            practice_name: practiceName,
            practice_phone: practicePhone,
          },
          conversation_config_override: { agent: { first_message: script, prompt: { prompt } } },
        },
      }),
    })
  } catch {
    const error = 'The server could not reach ElevenLabs.'
    await logToFirestore(uid, patient, purpose, phone, script, prompt, null, 'failed', error)
    await logToOpenDental(uid, patient, purpose, phone, script, null, 'failed', error)
    return { ok: false, status: 502, code: 'ELEVENLABS_UNREACHABLE', error }
  }

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = data.detail?.message || data.detail || data.message || 'ElevenLabs rejected the call.'
    await logToFirestore(uid, patient, purpose, phone, script, prompt, null, 'failed', error)
    await logToOpenDental(uid, patient, purpose, phone, script, null, 'failed', error)
    return { ok: false, status: response.status, error }
  }

  const conversationId = data.conversation_id || null
  await logToFirestore(uid, patient, purpose, phone, script, prompt, conversationId, 'initiated', null)
  await logToOpenDental(uid, patient, purpose, phone, script, conversationId, 'initiated', null)
  return { ok: true, status: 200, conversationId }
}
