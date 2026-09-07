import { NextResponse, after } from 'next/server'
import { randomUUID } from 'node:crypto'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'

export const runtime = 'nodejs'

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

const MAX_BATCH = 200
const MAX_CONCURRENCY = 3

function kickWorker(origin, body) {
  after(async () => {
    try {
      await fetch(`${origin}/api/tasks/process/step`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
    } catch {}
  })
}

// Task kind → saved call-script key, with built-in patient-facing scripts for the
// insurance kinds (the saved library has no patient-facing insurance script).
const KIND_SCRIPT_KEY = {
  appointment_confirmation: 'appointment',
  treatment_followup: 'followup',
  continuing_care: 'continuingCare',
  insurance_verification: 'insuranceVerification',
  insurance_missing: 'insuranceMissing',
}
const KIND_LABEL = {
  appointment_confirmation: 'Appointment confirmation',
  insurance_verification: 'Insurance verification',
  continuing_care: 'Continuing care',
  treatment_followup: 'Treatment follow-up',
  insurance_missing: 'Missing insurance',
}
const BUILTIN_SCRIPTS = {
  insuranceVerification: {
    label: 'Insurance verification (patient)',
    first: 'Hello {{patient_name}}, this is Corinne from {{practice_name}}. Ahead of your upcoming visit, I am calling to confirm your insurance details so we can verify your benefits. Could you confirm your insurance carrier, member ID, and subscriber name?',
    prompt: 'You are Corinne, a virtual receptionist for {{practice_name}}. Confirm the patient\'s insurance carrier, member ID, subscriber name, and whether anything changed recently, so the practice can verify benefits before the appointment. Verify identity before sharing appointment details. Never diagnose; escalate clinical or billing disputes to staff.',
  },
  insuranceMissing: {
    label: 'Missing insurance (patient)',
    first: 'Hello {{patient_name}}, this is Corinne from {{practice_name}}. We don\'t have insurance information on file for you ahead of your upcoming visit. Could you have your insurance card ready, or share the carrier and member ID with me now?',
    prompt: 'You are Corinne, a virtual receptionist for {{practice_name}}. The patient has an upcoming appointment but no coverage on file. Politely collect carrier, member ID, and subscriber details, or offer to note that they will bring the card. Verify identity before sharing appointment details. Never diagnose.',
  },
  generic: {
    label: 'Task call',
    first: 'Hello {{patient_name}}, this is Corinne from {{practice_name}}, calling with a quick message from the front desk.',
    prompt: 'You are Corinne, a professional virtual receptionist for {{practice_name}}. Work the front-desk task described in your instructions. Confirm you are speaking with {{patient_name}} before sharing any details. Be warm and concise, never diagnose or give emergency advice, and escalate anything urgent to staff.',
  },
}

function scriptFor(task, saved) {
  const key = KIND_SCRIPT_KEY[task.kind]
  const entry = (key && (saved[key] || BUILTIN_SCRIPTS[key])) || saved.appointment || BUILTIN_SCRIPTS.generic
  const purpose = task.kind ? (KIND_LABEL[task.kind] || saved[key]?.label || task.kind) : String(task.title || 'Front-desk task').slice(0, 80)
  let first = String(entry.first || BUILTIN_SCRIPTS.generic.first)
  let prompt = String(entry.prompt || BUILTIN_SCRIPTS.generic.prompt)
  if (!task.kind) {
    // Manual/CSV task: the title IS the instruction — steer the agent with it.
    prompt += `\n\nThe task for this call: ${String(task.title || '').slice(0, 300)}${task.notes ? ` — notes: ${String(task.notes).slice(0, 300)}` : ''}`
  }
  return { purpose, first, prompt }
}

// GET: latest run (for the UI to re-attach), or one run's detail with ?run=<id>.
export async function GET(request) {
  try {
    const user = await userFrom(request)
    const { searchParams } = new URL(request.url)
    const runId = searchParams.get('run')

    let ref
    if (runId) {
      ref = adminDb.doc(`users/${user.uid}/task-runs/${runId}`)
      const snap = await ref.get()
      if (!snap.exists) return NextResponse.json({ error: 'Batch run not found.' }, { status: 404 })
    } else {
      const latest = await adminDb.collection(`users/${user.uid}/task-runs`).orderBy('createdAt', 'desc').limit(1).get()
      if (latest.empty) return NextResponse.json({ run: null })
      ref = latest.docs[0].ref
    }
    const snap = await ref.get()
    const c = snap.data()
    const callsSnap = await ref.collection('calls').orderBy('order').get()
    const calls = callsSnap.docs.map((d) => {
      const a = d.data()
      return {
        id: d.id,
        taskId: a.taskId || null,
        title: a.title || '',
        patientName: a.patientName || '',
        phone: a.phone || '',
        status: a.status || 'queued',
        error: a.error || null,
        outcome: a.response?.outcome || null,
        summary: a.response?.summary ? String(a.response.summary).slice(0, 220) : null,
      }
    })
    return NextResponse.json({ run: { id: ref.id, status: c.status, total: c.total || calls.length }, calls })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not load the batch run.' }, { status: 500 })
  }
}

// POST: start a batch run over every open task that has a phone number.
export async function POST(request) {
  try {
    const user = await userFrom(request)
    const tasksSnap = await adminDb.collection(`users/${user.uid}/tasks`).where('status', '==', 'open').get()
    const tasks = tasksSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.phone)
    if (!tasks.length) {
      return NextResponse.json({ error: 'No open tasks with a phone number to call.' }, { status: 400 })
    }
    if (tasks.length > MAX_BATCH) {
      return NextResponse.json({ error: `Limit a batch to ${MAX_BATCH} tasks at a time.` }, { status: 400 })
    }
    const running = await adminDb.collection(`users/${user.uid}/task-runs`).where('status', '==', 'running').limit(1).get()
    if (!running.empty) {
      return NextResponse.json({ error: 'A batch run is already active. Stop it before starting a new one.', runId: running.docs[0].id }, { status: 409 })
    }

    const savedRaw = (await adminDb.doc(`users/${user.uid}/private/call-scripts`).get()).data()?.scripts || {}
    const saved = { ...BUILTIN_SCRIPTS, ...Object.fromEntries(Object.entries(savedRaw).filter(([, v]) => v && typeof v === 'object')) }

    const secret = randomUUID().replace(/-/g, '')
    const ref = adminDb.collection(`users/${user.uid}/task-runs`).doc()
    await ref.set({
      status: 'running',
      total: tasks.length,
      secret,
      ownerUid: user.uid,
      maxConcurrency: MAX_CONCURRENCY,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    let batch = adminDb.batch(), n = 0
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]
      const { purpose, first, prompt } = scriptFor(t, saved)
      const cref = ref.collection('calls').doc()
      batch.set(cref, {
        taskId: t.id,
        order: i,
        title: String(t.title || '').slice(0, 300),
        kind: String(t.kind || ''),
        patientName: String(t.patientName || '').slice(0, 200),
        patientId: Number.isInteger(t.patientId) ? t.patientId : null,
        phone: String(t.phone || '').replace(/[^+\d]/g, ''),
        purpose,
        scriptFirst: first.replaceAll('{{patient_name}}', String(t.patientName || 'there')),
        scriptPrompt: prompt.replaceAll('{{patient_name}}', String(t.patientName || 'there')),
        status: 'queued',
        createdAt: new Date(),
      })
      if (++n >= 450) { await batch.commit(); batch = adminDb.batch(); n = 0 }
    }
    if (n > 0) await batch.commit()

    kickWorker(new URL(request.url).origin, { uid: user.uid, runId: ref.id, secret })
    return NextResponse.json({ runId: ref.id, status: 'running', total: tasks.length })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not start the batch run.' }, { status: 500 })
  }
}

// PATCH: pause / resume / stop the active run. Resuming re-kicks the worker chain.
export async function PATCH(request) {
  try {
    const user = await userFrom(request)
    const { run, action } = await request.json().catch(() => ({}))
    if (!run) return NextResponse.json({ error: 'A run id is required.' }, { status: 400 })
    const ref = adminDb.doc(`users/${user.uid}/task-runs/${run}`)
    const snap = await ref.get()
    if (!snap.exists) return NextResponse.json({ error: 'Batch run not found.' }, { status: 404 })
    const c = snap.data()

    let status
    if (action === 'pause') status = 'paused'
    else if (action === 'resume') status = 'running'
    else if (action === 'stop') status = 'stopped'
    else return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })

    await ref.update({ status, updatedAt: new Date() })

    if (action === 'resume') {
      const origin = new URL(request.url).origin
      after(async () => {
        try {
          await fetch(`${origin}/api/tasks/process/step`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: user.uid, runId: run, secret: c.secret }),
          })
        } catch {}
      })
    }
    return NextResponse.json({ status })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not update the batch run.' }, { status: 500 })
  }
}
