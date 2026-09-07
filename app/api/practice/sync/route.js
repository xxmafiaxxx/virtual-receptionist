import { NextResponse } from 'next/server'
import { adminAuth } from '../../../../lib/firebase-admin'
import { syncPracticeFromOpenDental } from '../../../../lib/practice-settings'

export const runtime = 'nodejs'

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

// Pull live practice settings (practice identity, operatories, doctors + NPIs,
// staff) from the connected practice database and store them on the account.
// Open Dental today; the Dentrix bridge joins once its schema is mapped.
export async function POST(request) {
  try {
    const user = await userFrom(request)
    const result = await syncPracticeFromOpenDental(user.uid)
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status || 502 })
    return NextResponse.json(result)
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Practice sync failed.' }, { status: 500 })
  }
}
