import { NextResponse, after } from 'next/server'
import { randomUUID } from 'node:crypto'
import { adminAuth, adminDb } from '../../../lib/firebase-admin'

export const runtime = 'nodejs'

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

// Kick the server-side worker for a campaign without blocking the response.
function kickWorker(origin, body) {
  after(async () => {
    try {
      await fetch(`${origin}/api/campaigns/process`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
    } catch {}
  })
}

export async function GET(request) {
  try {
    const user = await userFrom(request)
    const snap = await adminDb.collection(`users/${user.uid}/campaigns`).orderBy('createdAt', 'desc').limit(1).get()
    if (snap.empty) return NextResponse.json({ campaign: null })
    const d = snap.docs[0], c = d.data()
    return NextResponse.json({ campaign: { id: d.id, status: c.status, total: c.total || 0 } })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Could not load campaigns.' }, { status: 500 })
  }
}

export async function POST(request) {
  try {
    const user = await userFrom(request)
    const { template, rows } = await request.json()
    const list = Array.isArray(rows) ? rows.filter((r) => r && r.name && r.phone && r.reason) : []
    if (!list.length) return NextResponse.json({ error: 'The call list is empty or missing name/phone/reason.' }, { status: 400 })
    if (list.length > 500) return NextResponse.json({ error: 'Limit a campaign to 500 calls.' }, { status: 400 })
    if (!template?.first || !template?.prompt) return NextResponse.json({ error: 'A campaign template is required.' }, { status: 400 })

    const secret = randomUUID().replace(/-/g, '')
    const ref = adminDb.collection(`users/${user.uid}/campaigns`).doc()
    await ref.set({
      status: 'running',
      template: { first: String(template.first), prompt: String(template.prompt) },
      total: list.length, secret, ownerUid: user.uid, createdAt: new Date(), updatedAt: new Date(),
    })

    let batch = adminDb.batch(), n = 0
    for (let i = 0; i < list.length; i++) {
      const cref = ref.collection('calls').doc()
      batch.set(cref, {
        name: String(list[i].name), phone: String(list[i].phone).replace(/[^+\d]/g, ''),
        email: String(list[i].email || ''), reason: String(list[i].reason),
        status: 'queued', order: i, createdAt: new Date(),
      })
      if (++n >= 450) { await batch.commit(); batch = adminDb.batch(); n = 0 }
    }
    if (n > 0) await batch.commit()

    kickWorker(new URL(request.url).origin, { uid: user.uid, campaignId: ref.id, secret })
    return NextResponse.json({ campaignId: ref.id, status: 'running', total: list.length })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Could not start the campaign.' }, { status: 500 })
  }
}
