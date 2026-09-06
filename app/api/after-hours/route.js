import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../lib/firebase-admin'

export const runtime = 'nodejs'

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')
const validTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)

const clean = (body = {}) => ({
  enabled: Boolean(body.enabled),
  kickoff: validTime(body.kickoff) ? body.kickoff : '19:00',
  first: String(body.first || ''),
  prompt: String(body.prompt || ''),
})

export async function GET(request) {
  try {
    const user = await userFrom(request)
    const snap = await adminDb.doc(`users/${user.uid}/private/after-hours`).get()
    const data = snap.data()
    return NextResponse.json({ config: data ? clean(data) : null })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Could not load after-hours settings.' }, { status: 500 })
  }
}

export async function POST(request) {
  try {
    const user = await userFrom(request)
    const body = await request.json()
    const config = clean(body)
    await adminDb.doc(`users/${user.uid}/private/after-hours`).set({ ...config, updatedAt: new Date(), ownerUid: user.uid }, { merge: true })
    return NextResponse.json({ config })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Could not save after-hours settings.' }, { status: 500 })
  }
}
