import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../lib/firebase-admin'

export const runtime = 'nodejs'

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

export async function GET(request) {
  try {
    const user = await userFrom(request)
    const snap = await adminDb.doc(`users/${user.uid}/private/call-scripts`).get()
    return NextResponse.json({ scripts: snap.data()?.scripts || null })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Could not load call scripts.' }, { status: 500 })
  }
}

export async function POST(request) {
  try {
    const user = await userFrom(request)
    const { scripts } = await request.json()
    if (!scripts || typeof scripts !== 'object') return NextResponse.json({ error: 'A scripts payload is required.' }, { status: 400 })
    const clean = {}
    for (const [k, v] of Object.entries(scripts)) {
      if (v && typeof v === 'object') clean[k] = { label: String(v.label || k), first: String(v.first || ''), prompt: String(v.prompt || '') }
    }
    await adminDb.doc(`users/${user.uid}/private/call-scripts`).set({ scripts: clean, updatedAt: new Date(), ownerUid: user.uid }, { merge: true })
    return NextResponse.json({ scripts: clean })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Could not save call scripts.' }, { status: 500 })
  }
}
