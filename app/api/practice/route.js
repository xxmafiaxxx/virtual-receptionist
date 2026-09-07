import { NextResponse } from 'next/server'
import { adminAuth } from '../../../lib/firebase-admin'
import { getPracticeSettings, savePracticeSettings } from '../../../lib/practice-settings'

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
    const settings = await getPracticeSettings(user.uid)
    return NextResponse.json({ settings })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not load practice settings.' }, { status: 500 })
  }
}

// Manual edits from Settings → Practice. Database syncs (POST /api/practice/sync)
// overwrite these; manual saves win between syncs.
export async function POST(request) {
  try {
    const user = await userFrom(request)
    const body = await request.json()
    const settings = await savePracticeSettings(user.uid, {
      practice: body?.practice,
      operatories: body?.operatories,
      doctors: body?.doctors,
      staff: body?.staff,
    })
    return NextResponse.json({ settings })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not save practice settings.' }, { status: 500 })
  }
}
