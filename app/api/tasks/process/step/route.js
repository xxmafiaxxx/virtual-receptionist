import { NextResponse, after } from 'next/server'
import { adminDb } from '../../../../../lib/firebase-admin'
import { placeOutboundCall, getElevenLabsKey, logCallResponse } from '../../../../../lib/outbound-call'

export const runtime = 'nodejs'
export const maxDuration = 60

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// A placed conversation with no reportable outcome after this long is failed so the run
// can finish (ElevenLabs conversations normally report within minutes).
const STUCK_MS = 12 * 60 * 1000

function chain(origin, body, delay) {
  after(async () => {
    await sleep(delay)
    try {
      await fetch(`${origin}/api/tasks/process/step`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
    } catch {}
  })
}

// Record a failure with no usable conversation response: run doc, task lastCall, and the
// initiation entry in call-history when a conversationId exists.
async function failCall(uid, runId, call, error) {
  await call.ref.update({ status: 'failed', error: String(error).slice(0, 800), updatedAt: new Date() })
  await logCallResponse(uid, { name: call.patientName, id: call.patientId, phone: call.phone }, call.conversationId || null, { outcome: 'failure', summary: error, transcript: '', durationSec: null }, call.purpose)
  try {
    await adminDb.doc(`users/${uid}/tasks/${call.taskId}`).update({
      status: 'open',
      lastCall: { conversationId: call.conversationId || null, outcome: 'failure', summary: String(error).slice(0, 300), at: new Date() },
    })
  } catch {}
}

// Public worker endpoint: authorized by the per-run secret (server-only). Each invocation
// performs ONE step — collect any finished conversation's response, else dial the next
// queued task — then chains the next step via after() so the run survives tab closes.
export async function POST(request) {
  try {
    const { uid, runId, secret } = await request.json().catch(() => ({}))
    if (!uid || !runId || !secret) return NextResponse.json({ error: 'bad request' }, { status: 400 })

    const runRef = adminDb.doc(`users/${uid}/task-runs/${runId}`)
    const runSnap = await runRef.get()
    const run = runSnap.data()
    if (!run || run.secret !== secret) return NextResponse.json({ error: 'not authorized' }, { status: 403 })
    if (run.status !== 'running') return NextResponse.json({ status: run.status })
    const origin = new URL(request.url).origin

    const callsCol = runRef.collection('calls')
    const placed = await callsCol.where('status', '==', 'placed').limit(10).get()

    // 1. Collect responses for conversations that have finished.
    const apiKey = await getElevenLabsKey(uid)
    let collected = 0
    for (const doc of placed.docs) {
      const call = { ref: doc.ref, ...doc.data() }
      const placedAt = call.placedAt?.toMillis ? call.placedAt.toMillis() : Date.now()
      const stuck = Date.now() - placedAt > STUCK_MS
      if (!apiKey) {
        if (stuck) { await failCall(uid, runId, call, 'ElevenLabs API key unavailable — no response captured.'); collected++ }
        continue
      }
      let res
      try {
        res = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${call.conversationId}`, { headers: { 'xi-api-key': apiKey } })
      } catch { continue }
      if (res.status === 404) {
        if (stuck) { await failCall(uid, runId, call, 'No conversation was created — the call never connected.'); collected++ }
        continue
      }
      if (!res.ok) continue
      const data = await res.json().catch(() => ({}))
      const status = String(data.status || '')
      if (status !== 'done' && status !== 'completed') {
        if (stuck) { await failCall(uid, runId, call, 'Call outcome was never reported.'); collected++ }
        continue
      }
      const transcript = Array.isArray(data.transcript)
        ? data.transcript.map((t) => `${t.role === 'agent' ? 'Corinne' : 'Patient'}: ${t.message}`).join('\n').slice(0, 8000)
        : ''
      const response = {
        summary: String(data.analysis?.transcript_summary || '').slice(0, 2000),
        outcome: data.analysis?.call_successful || null,
        transcript,
        durationSec: Number.isFinite(Number(data.call_duration_secs)) ? Number(data.call_duration_secs) : null,
      }
      const ok = response.outcome !== 'failure' && response.outcome !== 'no_answer'
      await doc.ref.update({
        status: ok ? 'done' : 'failed',
        error: ok ? null : `Call outcome: ${response.outcome || 'unknown'}`,
        response,
        updatedAt: new Date(),
      })
      await logCallResponse(uid, { name: call.patientName, id: call.patientId, phone: call.phone }, call.conversationId, response, call.purpose)
      try {
        await adminDb.doc(`users/${uid}/tasks/${call.taskId}`).update({
          status: ok ? 'done' : 'open',
          lastCall: { conversationId: call.conversationId, outcome: response.outcome || (ok ? 'success' : 'failure'), summary: response.summary.slice(0, 300), at: new Date() },
        })
      } catch {}
      collected++
    }

    // Orphaned claims: a worker that died between claim and dial leaves 'calling' docs
    // behind that would otherwise keep the run from ever completing.
    const staleCalling = await callsCol.where('status', '==', 'calling').limit(10).get()
    for (const doc of staleCalling.docs) {
      const c = doc.data()
      const updatedAt = c.updatedAt?.toMillis ? c.updatedAt.toMillis() : Date.now()
      if (Date.now() - updatedAt > 5 * 60 * 1000) {
        await failCall(uid, runId, { ref: doc.ref, ...c, conversationId: null }, 'Batch worker stopped mid-dial — the call was never placed; retry the task.')
        collected++
      }
    }
    if (collected) {
      chain(origin, { uid, runId, secret }, 1500)
      return NextResponse.json({ ok: true, collected })
    }

    // 2. Dial the next queued task if a line is free.
    if (placed.size < (run.maxConcurrency || 3)) {
      const claimed = await adminDb.runTransaction(async (tx) => {
        const q = await tx.get(callsCol.where('status', '==', 'queued').limit(1))
        if (q.empty) return null
        const doc = q.docs[0]
        tx.update(doc.ref, { status: 'calling', updatedAt: new Date() })
        return { ref: doc.ref, ...doc.data() }
      })
      if (claimed) {
        const result = await placeOutboundCall(uid, {
          patient: { name: claimed.patientName, phone: claimed.phone, id: claimed.patientId },
          purpose: claimed.purpose,
          script: claimed.scriptFirst,
          prompt: claimed.scriptPrompt,
        })
        if (result.ok) {
          await claimed.ref.update({ status: 'placed', conversationId: result.conversationId, placedAt: new Date(), updatedAt: new Date() })
        } else {
          await failCall(uid, runId, { ...claimed, conversationId: null }, result.error || 'Call failed.')
        }
      }
    }

    // 3. Completion check: anything still queued or awaiting a response keeps the chain alive.
    const remaining = await callsCol.where('status', 'in', ['queued', 'placed', 'calling']).count().get()
    if (remaining.data().count === 0) {
      await runRef.update({ status: 'completed', updatedAt: new Date() })
      return NextResponse.json({ status: 'completed' })
    }
    chain(origin, { uid, runId, secret }, 5000)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'processing error' }, { status: 500 })
  }
}
