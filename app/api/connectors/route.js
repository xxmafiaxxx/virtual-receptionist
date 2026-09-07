import { NextResponse } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { adminAuth, adminDb } from '../../../lib/firebase-admin'
import { encryptSecret } from '../../../lib/secret-crypto'
import { syncPracticeFromOpenDental } from '../../../lib/practice-settings'

export const runtime = 'nodejs'

const ENGINES = ['PostgreSQL', 'MySQL / MariaDB', 'Microsoft SQL Server', 'Oracle', 'MongoDB', 'SQLite', 'Firestore', 'REST API', 'FHIR R4', 'HL7 v2', 'Other / custom']

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')
const secretKeyFor = (system) => `CONNECTOR_${String(system).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`

const cleanConfig = (raw = {}) => {
  const engine = ENGINES.includes(raw.engine) ? raw.engine : 'Other / custom'
  const str = (v, max) => String(v ?? '').slice(0, max)
  return {
    engine,
    host: str(raw.host, 120).trim(),
    port: str(raw.port, 5).replace(/\D/g, ''),
    database: str(raw.database, 120).trim(),
    endpoint: str(raw.endpoint, 300).trim(),
    user: str(raw.user, 80).trim(),
    secret: str(raw.secret, 80).replace(/[^A-Za-z0-9_]/g, '').toUpperCase(),
    ssl: Boolean(raw.ssl),
  }
}

export async function GET(request) {
  try {
    const user = await userFrom(request)
    const snap = await adminDb.doc(`users/${user.uid}/private/connectors`).get()
    return NextResponse.json({ configs: snap.data()?.configs || {} })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Could not load connector settings.' }, { status: 500 })
  }
}

export async function POST(request) {
  try {
    const user = await userFrom(request)
    const body = await request.json()
    const system = String(body.system || '').trim().slice(0, 60)
    if (!system) return NextResponse.json({ error: 'Connector name is required.' }, { status: 400 })

    const ref = adminDb.doc(`users/${user.uid}/private/connectors`)
    const current = (await ref.get()).data()?.configs || {}
    const key = secretKeyFor(system)

    // password semantics: non-empty string sets/rotates the stored secret,
    // explicit null clears it, anything else leaves the saved value untouched.
    if (body.password === null) {
      await adminDb.doc(`users/${user.uid}/private/integration-secrets`)
        .update({ [`secrets.${key}`]: FieldValue.delete(), updatedAt: new Date() })
        .catch(() => {})
    } else if (typeof body.password === 'string' && body.password.length) {
      await adminDb.doc(`users/${user.uid}/private/integration-secrets`).set(
        { ownerUid: user.uid, secrets: { [key]: encryptSecret(body.password.slice(0, 500)) }, updatedAt: new Date() },
        { merge: true },
      )
    }

    if (!body.config) return NextResponse.json({ config: current[system] || null })
    const config = cleanConfig(body.config)
    const configs = { ...current, [system]: { ...config, updatedAt: new Date().toISOString() } }
    await ref.set({ ownerUid: user.uid, configs, updatedAt: new Date() }, { merge: true })

    // First time a practice database is saved, pull its practice settings
    // (name, operatories, doctors + NPIs, staff) so the app reflects the real
    // practice. Best-effort: a failed sync never blocks saving the connector.
    let practiceSync = null
    if (config.engine === 'MySQL / MariaDB' && config.host) {
      const synced = await syncPracticeFromOpenDental(user.uid).catch(() => null)
      if (synced?.ok) practiceSync = { counts: synced.counts, source: synced.source }
    }
    return NextResponse.json({ config: configs[system], practiceSync })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: 'Could not save connector settings.' }, { status: 500 })
  }
}
