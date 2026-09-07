import { NextResponse } from 'next/server'
import { adminAuth } from '../../../lib/firebase-admin'
import { chatCompletion, llmStatus } from '../../../lib/llm'

export const runtime = 'nodejs'

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

// Health of the AI chain: primary cloud provider + local Ollama backup.
export async function GET(request) {
  try {
    await userFrom(request)
    return NextResponse.json(await llmStatus())
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Could not read AI chain status.' }, { status: 500 })
  }
}

// Runs a prompt through the backup chain and reports which provider answered.
export async function POST(request) {
  try {
    await userFrom(request)
    const body = await request.json().catch(() => ({}))
    const result = await chatCompletion({
      prompt: String(body.prompt || 'Reply with exactly: READY').slice(0, 4000),
      system: typeof body.system === 'string' ? body.system.slice(0, 2000) : undefined,
      maxTokens: Math.min(Math.max(Number(body.maxTokens) || 60, 8), 1000),
      prefer: body.prefer === 'local' ? 'local' : undefined,
    })
    return NextResponse.json(result)
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'The AI chain failed.' }, { status: 500 })
  }
}
