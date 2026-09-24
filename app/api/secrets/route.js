import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../lib/firebase-admin'
import { encryptSecret } from '../../../lib/secret-crypto'

export const runtime = 'nodejs'
const allowed = ['openai','anthropic','google','elevenlabs','elevenlabsAgentId','elevenlabsPhoneNumberId','twilioSid','twilioToken','dentrixBridgeUrl','dentrixBridgeToken','odBridgeUrl','odBridgeToken']

function configurationError() {
  const serviceAccountConfigured = Boolean(
    process.env.FIREBASE_ADMIN_PROJECT_ID &&
    process.env.FIREBASE_ADMIN_CLIENT_EMAIL &&
    process.env.FIREBASE_ADMIN_PRIVATE_KEY
  )
  const applicationDefaultConfigured = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  if (!serviceAccountConfigured && !applicationDefaultConfigured) {
    return 'Firebase Admin credentials are missing. Add FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, and FIREBASE_ADMIN_PRIVATE_KEY to .env.'
  }
  if (!process.env.APP_ENCRYPTION_KEY) return 'APP_ENCRYPTION_KEY is missing from .env.'
  try {
    if (Buffer.from(process.env.APP_ENCRYPTION_KEY, 'base64').length !== 32) {
      return 'APP_ENCRYPTION_KEY must be a 32-byte base64 value.'
    }
  } catch { return 'APP_ENCRYPTION_KEY is not valid base64.' }
  return null
}

async function userFrom(request) {
  const value = request.headers.get('authorization') || ''
  if (!value.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(value.slice(7), true)
}

export async function GET(request) {
  try {
    const configError = configurationError()
    if (configError) return NextResponse.json({ error: configError }, { status: 503 })
    const user = await userFrom(request)
    const snapshot = await adminDb.doc(`users/${user.uid}/private/integration-secrets`).get()
    const secrets = snapshot.data()?.secrets || {}
    return NextResponse.json({ configured: Object.fromEntries(allowed.map(k => [k, Boolean(secrets[k])])) })
  } catch (error) {
    if (error?.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Firestore could not load credential status. Confirm Firestore and Firebase Admin access are configured.' }, { status: 500 })
  }
}

export async function POST(request) {
  try {
    const configError = configurationError()
    if (configError) return NextResponse.json({ error: configError }, { status: 503 })
    const user = await userFrom(request)
    const body = await request.json()
    const ref = adminDb.doc(`users/${user.uid}/private/integration-secrets`)
    const snapshot = await ref.get()
    const secrets = { ...(snapshot.data()?.secrets || {}) }
    for (const key of allowed) {
      if (typeof body[key] === 'string' && body[key].trim()) secrets[key] = encryptSecret(body[key].trim())
    }
    await ref.set({ secrets, updatedAt: new Date(), ownerUid: user.uid }, { merge: true })
    return NextResponse.json({ configured: Object.fromEntries(allowed.map(k => [k, Boolean(secrets[k])])) })
  } catch (error) {
    console.error('Encrypted secret write failed', { code: error?.code, name: error?.name })
    const authFailure = error?.message === 'Unauthorized' || String(error?.code || '').startsWith('auth/')
    const status = authFailure ? 401 : 500
    const detail = error?.code ? ` Server code: ${error.code}.` : ''
    const message = authFailure ? 'Your Google session expired. Sign out and sign in again.' : `Firestore could not store the encrypted secret.${detail} Restart the app after changing .env.`
    return NextResponse.json({ error: message }, { status })
  }
}
