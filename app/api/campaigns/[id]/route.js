import { NextResponse, after } from 'next/server'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'

export const runtime = 'nodejs'

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

export async function GET(request, { params }) {
  try {
    const user = await userFrom(request)
    const { id } = await params
    const ref = adminDb.doc(`users/${user.uid}/campaigns/${id}`)
    const snap = await ref.get()
    if (!snap.exists) return NextResponse.json({ error: 'Campaign not found.' }, { status: 404 })
    const c = snap.data()
    const callsSnap = await ref.collection('calls').orderBy('order').get()
    const calls = callsSnap.docs.map((d) => {
      const a = d.data()
      return { id: d.id, name: a.name, phone: a.phone, reason: a.reason, status: a.status, error: a.error || null }
    })
    return NextResponse.json({ id, status: c.status, total: c.total || calls.length, calls })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Could not load the campaign.' }, { status: 500 })
  }
}

export async function PATCH(request, { params }) {
  try {
    const user = await userFrom(request)
    const { id } = await params
    const { action } = await request.json().catch(() => ({}))
    const ref = adminDb.doc(`users/${user.uid}/campaigns/${id}`)
    const snap = await ref.get()
    if (!snap.exists) return NextResponse.json({ error: 'Campaign not found.' }, { status: 404 })
    const c = snap.data()

    let status
    if (action === 'pause') status = 'paused'
    else if (action === 'resume') status = 'running'
    else if (action === 'stop') status = 'stopped'
    else return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })

    await ref.update({ status, updatedAt: new Date() })

    // Resuming restarts the self-advancing worker chain.
    if (action === 'resume') {
      const origin = new URL(request.url).origin
      after(async () => {
        try {
          await fetch(`${origin}/api/campaigns/process`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: user.uid, campaignId: id, secret: c.secret }),
          })
        } catch {}
      })
    }
    return NextResponse.json({ status })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Could not update the campaign.' }, { status: 500 })
  }
}
