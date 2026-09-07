import { NextResponse } from 'next/server'
import { adminAuth } from '../../../lib/firebase-admin'
import { dentrixConfig, bridgeFetch } from '../../../lib/dentrix'

export const runtime = 'nodejs'

// Proxy to the on-site Dentrix bridge (see bridge/README.md). Read-only:
// status, patient browse/search, per-patient appointments. The bridge URL and
// token are stored encrypted in integration-secrets (Connectors → Dentrix).
async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}

const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

export async function GET(request) {
  try {
    const user = await userFrom(request)
    const config = await dentrixConfig(user.uid)
    const { searchParams } = new URL(request.url)
    const phone = searchParams.get('phone')
    const name = searchParams.get('name')
    const id = searchParams.get('id')
    const appointments = searchParams.get('appointments')
    const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 50, 1), 200)
    const offset = Math.max(Number(searchParams.get('offset')) || 0, 0)

    let path
    if (appointments && id) path = `/patients/${encodeURIComponent(id)}/appointments`
    else if (phone) path = `/patients?phone=${encodeURIComponent(phone)}`
    else if (name) path = `/patients?name=${encodeURIComponent(name)}`
    else if (id) path = `/patients?id=${encodeURIComponent(id)}`
    else if (searchParams.has('limit') || searchParams.has('offset')) path = `/patients?limit=${limit}&offset=${offset}`
    else path = '/' // status probe

    const { status, body } = await bridgeFetch(config, path)

    if (path === '/') {
      return NextResponse.json({
        ok: Boolean(config.url && config.token) && status === 200,
        configured: Boolean(config.url && config.token),
        reachable: status === 200,
        schemaMapped: status === 200 ? Boolean(body.schemaMapped) : false,
        db: body.db || null,
        version: body.version || null,
        error: status === 200 ? null : body.error || 'Bridge did not respond.',
      })
    }

    return NextResponse.json(body, { status })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not reach the Dentrix bridge.' }, { status: 500 })
  }
}
