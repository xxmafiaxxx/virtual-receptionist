import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'
const envPath = fileURLToPath(new URL('../.env', import.meta.url))
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
process.env.GOOGLE_APPLICATION_CREDENTIALS = fileURLToPath(new URL('../corinne--virtual-receptionist-firebase-adminsdk-fbsvc-bc6ba0e89e.json', import.meta.url))
const { initializeApp, applicationDefault } = await import('firebase-admin/app')
const { getAuth } = await import('firebase-admin/auth')
const { getFirestore } = await import('firebase-admin/firestore')
initializeApp({ credential: applicationDefault() })
const auth = getAuth(), db = getFirestore()
const BASE = 'http://localhost:3000'
const j = async r => ({ status: r.status, d: await r.json().catch(() => ({})) })

// throwaway user — empty vault => every dial fails safely at the decrypt step
const user = await auth.createUser({ email: `batch-e2e-${Date.now()}@corinne.local`, password: 'xK9!tst' + Math.random().toString(36).slice(2), displayName: 'Batch E2E' })
const UID = user.uid
const key = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, sub: key.client_email, aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit', iat: now, exp: now + 3600, uid: UID })}`
const s = createSign('RSA-SHA256'); s.update(head)
const jwt = `${head}.${s.sign(key.private_key).toString('base64url')}`
const idtok = (await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`, { method: 'POST', body: new URLSearchParams({ token: jwt, returnSecureToken: 'true' }) })).json()).idToken
if (!idtok) { console.log('AUTH FAILED'); process.exit(1) }
const H = { Authorization: `Bearer ${idtok}`, 'Content-Type': 'application/json' }
let pass = 0, failn = 0
const check = (name, cond, extra) => { console.log(cond ? `PASS ${name}` : `FAIL ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 220) : ''); cond ? pass++ : failn++ }

console.log('== 1. unauth guards ==')
check('POST process 401', (await j(await fetch(`${BASE}/api/tasks/process`, { method: 'POST' }))).status === 401)
check('GET process 401', (await j(await fetch(`${BASE}/api/tasks/process`))).status === 401)
check('PATCH process 401', (await j(await fetch(`${BASE}/api/tasks/process`, { method: 'PATCH', body: '{}' }))).status === 401)
const step = await j(await fetch(`${BASE}/api/tasks/process/step`, { method: 'POST', body: '{}' }))
check('step bad request 400', step.status === 400)
const stepBad = await j(await fetch(`${BASE}/api/tasks/process/step`, { method: 'POST', body: JSON.stringify({ uid: UID, runId: 'x', secret: 'y' }) }))
check('step bad secret 403', stepBad.status === 403)

console.log('== 2. empty task list guard ==')
const emptyStart = await j(await fetch(`${BASE}/api/tasks/process`, { method: 'POST', headers: H }))
check('start with 0 tasks 400', emptyStart.status === 400, emptyStart.d)

console.log('== 3. create test task + start run ==')
const mk = await j(await fetch(`${BASE}/api/tasks`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'E2E batch test call', patientName: 'Batch Test', phone: '+15555550100', kind: 'appointment_confirmation' }) }))
check('task created', mk.status === 200, mk.d)
const start = await j(await fetch(`${BASE}/api/tasks/process`, { method: 'POST', headers: H }))
check('run started', start.status === 200 && !!start.d.runId, start.d)
const runId = start.d.runId

console.log('== 4. poll run to completion (dial fails safely at decrypt) ==')
let run = null, calls = []
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const st = await j(await fetch(`${BASE}/api/tasks/process?run=${runId}`, { headers: H }))
  if (st.status !== 200) { console.log('poll err', st.status, st.d); break }
  run = st.d.run; calls = st.d.calls
  console.log(`  poll ${i}: run=${run.status} calls=`, calls.map(c => `${c.status}${c.error ? `(${c.error.slice(0, 40)})` : ''}`).join(','))
  if (run.status !== 'running') break
}
check('run completed', run?.status === 'completed')
check('call failed (no vault keys)', calls[0]?.status === 'failed', calls[0]?.error)
check('task summary looks right', calls[0]?.title === 'E2E batch test call' && calls[0]?.patientName === 'Batch Test')

console.log('== 5. task side-effects ==')
const list = await j(await fetch(`${BASE}/api/tasks`, { headers: H }))
const t = list.d.tasks.find(x => x.id === mk.d.ids?.[0])
check('task still open after failed call', t?.status === 'open')
check('task lastCall logged', !!t?.lastCall && /decrypt|api key|setup/i.test(t.lastCall.summary || ''), t?.lastCall)
const hist = await db.collection(`users/${UID}/call-history`).get()
check('call-history entry logged', !hist.empty && ['failed'].includes(hist.docs[0].data().status), hist.docs[0]?.data()?.error)

console.log('== 6. pause control + stuck-collection path ==')
await fetch(`${BASE}/api/tasks`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'E2E stuck call test', patientName: 'Stuck Test', phone: '+15555550100', kind: 'continuing_care' }) })
const start2 = await j(await fetch(`${BASE}/api/tasks/process`, { method: 'POST', headers: H }))
check('run2 started', start2.status === 200, start2.d)
const run2 = start2.d.runId
const pause = await j(await fetch(`${BASE}/api/tasks/process`, { method: 'PATCH', headers: H, body: JSON.stringify({ run: run2, action: 'pause' }) }))
check('pause 200', pause.status === 200 && pause.d.status === 'paused')
await new Promise(r => setTimeout(r, 2500))
const pausedState = await j(await fetch(`${BASE}/api/tasks/process?run=${run2}`, { headers: H }))
check('run stays paused', pausedState.d.run.status === 'paused', pausedState.d.run)
// manually simulate a conversation placed 13 min ago, then resume -> stuck branch must fail it and complete
const callDocs = await db.collection(`users/${UID}/task-runs/${run2}/calls`).where('status', '==', 'queued').limit(1).get()
if (!callDocs.empty) {
  await callDocs.docs[0].ref.update({ status: 'placed', conversationId: 'e2e-fake-conversation', placedAt: new Date(Date.now() - 13 * 60 * 1000) })
  console.log('  simulated stuck placed call')
}
const resume = await j(await fetch(`${BASE}/api/tasks/process`, { method: 'PATCH', headers: H, body: JSON.stringify({ run: run2, action: 'resume' }) }))
check('resume 200', resume.status === 200 && resume.d.status === 'running')
let run2final = null, calls2 = []
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const st = await j(await fetch(`${BASE}/api/tasks/process?run=${run2}`, { headers: H }))
  if (st.status !== 200) break
  run2final = st.d.run; calls2 = st.d.calls
  console.log(`  poll ${i}: run=${run2final.status} calls=`, calls2.map(c => c.status).join(','))
  if (run2final.status !== 'running') break
}
check('run2 completed', run2final?.status === 'completed')
const stuckCall = calls2[0]
check('stuck call failed with clear reason', stuckCall?.status === 'failed' && /never connected|api key/i.test(stuckCall.error || ''), stuckCall?.error)

console.log('== 7. stop control on a fresh run ==')
await fetch(`${BASE}/api/tasks`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'E2E stop test', patientName: 'Stop Test', phone: '+15555550100' }) })
const start3 = await j(await fetch(`${BASE}/api/tasks/process`, { method: 'POST', headers: H }))
const stop = await j(await fetch(`${BASE}/api/tasks/process`, { method: 'PATCH', headers: H, body: JSON.stringify({ run: start3.d.runId, action: 'stop' }) }))
check('stop 200', stop.status === 200 && stop.d.status === 'stopped')

console.log('== 8. cleanup ==')
const allTasks = await db.collection(`users/${UID}/tasks`).get()
for (const d of allTasks.docs) await d.ref.delete()
for (const r of [runId, run2, start3.d.runId]) {
  const callsSnap = await db.collection(`users/${UID}/task-runs/${r}/calls`).get()
  for (const d of callsSnap.docs) await d.ref.delete()
  await db.doc(`users/${UID}/task-runs/${r}`).delete()
}
const hist2 = await db.collection(`users/${UID}/call-history`).get()
for (const d of hist2.docs) await d.ref.delete()
await auth.deleteUser(UID)
console.log('cleanup done')
console.log(`\nRESULT: ${pass} passed, ${failn} failed`)
process.exit(failn ? 1 : 0)
