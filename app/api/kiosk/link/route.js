import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'

export const runtime = 'nodejs'

async function userFrom(request) {
  const value = request.headers.get('authorization') || ''
  if (!value.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(value.slice(7), true)
}

function authFailure(error) {
  return error?.message === 'Unauthorized' || String(error?.code || '').startsWith('auth/')
}

export async function GET(request) {
  try {
    const user = await userFrom(request)
    const snap = await adminDb.doc(`users/${user.uid}/private/kiosk`).get()
    const data = snap.data() || {}
    return NextResponse.json({ token: data.token || null, enabled: Boolean(data.enabled) })
  } catch (error) {
    if (authFailure(error)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not load the kiosk link.' }, { status: 500 })
  }
}

export async function POST(request) {
  try {
    const user = await userFrom(request)
    const body = await request.json().catch(() => ({}))
    const ref = adminDb.doc(`users/${user.uid}/private/kiosk`)
    const current = (await ref.get()).data() || {}
    let token = current.token
    let enabled = current.enabled ?? true

    // Generate a fresh token on first setup or explicit reset; a reset revokes the old link.
    if (body.action === 'reset' || !token) {
      if (token) await adminDb.doc(`kiosk-links/${token}`).delete().catch(() => {})
      token = randomUUID().replace(/-/g, '')
    }
    if (typeof body.enabled === 'boolean') enabled = body.enabled

    await ref.set({ token, enabled, updatedAt: new Date(), ownerUid: user.uid }, { merge: true })
    // Reverse lookup doc lets the public check-in route resolve a token to a practice without a login.
    await adminDb.doc(`kiosk-links/${token}`).set({ uid: user.uid, enabled })
    return NextResponse.json({ token, enabled })
  } catch (error) {
    if (authFailure(error)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not update the kiosk link.' }, { status: 500 })
  }
}
