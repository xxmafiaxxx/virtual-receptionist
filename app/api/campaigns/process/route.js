import { NextResponse, after } from 'next/server'
import { adminDb } from '../../../../lib/firebase-admin'
import { placeOutboundCall } from '../../../../lib/outbound-call'

export const runtime = 'nodejs'
export const maxDuration = 60

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Public worker endpoint: authorized by the per-campaign secret (server-only, never sent to
// clients). Processes ONE queued call per invocation, then chains the next via after() so the
// campaign keeps running even after the admin closes the browser tab.
export async function POST(request) {
  try {
    const { uid, campaignId, secret } = await request.json().catch(() => ({}))
    if (!uid || !campaignId || !secret) return NextResponse.json({ error: 'bad request' }, { status: 400 })

    const ref = adminDb.doc(`users/${uid}/campaigns/${campaignId}`)
    const snap = await ref.get()
    const campaign = snap.data()
    if (!campaign || campaign.secret !== secret) return NextResponse.json({ error: 'not authorized' }, { status: 403 })
    if (campaign.status !== 'running') return NextResponse.json({ status: campaign.status })

    const callsCol = ref.collection('calls')
    // Atomically claim the next queued call so two overlapping workers can never dial the same row.
    const claimed = await adminDb.runTransaction(async (tx) => {
      const q = await tx.get(callsCol.where('status', '==', 'queued').limit(1))
      if (q.empty) return null
      const doc = q.docs[0]
      tx.update(doc.ref, { status: 'calling', updatedAt: new Date() })
      return { ref: doc.ref, ...doc.data() }
    })

    if (!claimed) {
      await ref.update({ status: 'completed', updatedAt: new Date() })
      return NextResponse.json({ status: 'completed' })
    }

    const first = String(campaign.template?.first || '').replaceAll('{{patient_name}}', claimed.name).replaceAll('{{reason}}', claimed.reason)
    const prompt = String(campaign.template?.prompt || '').replaceAll('{{patient_name}}', claimed.name).replaceAll('{{reason}}', claimed.reason)
    const result = await placeOutboundCall(uid, {
      patient: { name: claimed.name, phone: claimed.phone, email: claimed.email },
      purpose: claimed.reason, script: first, prompt,
    })
    await claimed.ref.update({ status: result.ok ? 'done' : 'failed', error: result.ok ? null : (result.error || 'Call failed.'), updatedAt: new Date() })

    // Re-read status so a pause/stop issued while this call was dialing is honored before chaining.
    const fresh = (await ref.get()).data()
    if (fresh?.status === 'running') {
      const origin = new URL(request.url).origin
      after(async () => {
        await sleep(1200)
        try {
          await fetch(`${origin}/api/campaigns/process`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid, campaignId, secret }),
          })
        } catch {}
      })
    }
    return NextResponse.json({ ok: true, result: result.ok })
  } catch {
    return NextResponse.json({ error: 'processing error' }, { status: 500 })
  }
}
