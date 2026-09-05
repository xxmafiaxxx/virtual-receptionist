import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'
import { decryptSecret } from '../../../../lib/secret-crypto'

export const runtime = 'nodejs'

export async function POST(request) {
  try {
    const authHeader = request.headers.get('authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return NextResponse.json({ error: 'Sign in again.' }, { status: 401 })
    const user = await adminAuth.verifyIdToken(authHeader.slice(7), true)
    const { voiceId, text } = await request.json()
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(voiceId || '')) return NextResponse.json({ error: 'Enter a valid ElevenLabs voice ID.' }, { status: 400 })
    const snapshot = await adminDb.doc(`users/${user.uid}/private/integration-secrets`).get()
    const apiKey = decryptSecret(snapshot.data()?.secrets?.elevenlabs)
    if (!apiKey) return NextResponse.json({ error: 'Add your ElevenLabs API key under API keys.' }, { status: 409 })
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({ text: String(text || 'Hello, this is Corinne from your healthcare practice. How may I help you today?').slice(0, 500), model_id: 'eleven_multilingual_v2' }),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      return NextResponse.json({ error: data.detail?.message || data.detail || 'ElevenLabs could not generate this preview.' }, { status: response.status })
    }
    return new Response(await response.arrayBuffer(), { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (String(error?.code || '').startsWith('auth/')) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Voice preview could not be generated.' }, { status: 500 })
  }
}
