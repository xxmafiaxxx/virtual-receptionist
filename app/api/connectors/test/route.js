import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'
import { decryptSecret } from '../../../../lib/secret-crypto'
import { odBridgeConfig } from '../../../../lib/opendental'

export const runtime = 'nodejs'

const secretKeyFor = (system) => `CONNECTOR_${String(system).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

export async function POST(request) {
  try {
    const user = await userFrom(request)
    const { system } = await request.json()
    const name = String(system || '').trim().slice(0, 60)
    if (!name) return NextResponse.json({ ok: false, error: 'Connector name is required.' }, { status: 400 })

    const [configSnap, secretsSnap] = await Promise.all([
      adminDb.doc(`users/${user.uid}/private/connectors`).get(),
      adminDb.doc(`users/${user.uid}/private/integration-secrets`).get(),
    ])
    const config = configSnap.data()?.configs?.[name]
    if (!config) return NextResponse.json({ ok: false, error: 'Save this connector first, then test it.' }, { status: 404 })

    if (config.engine !== 'MySQL / MariaDB') {
      return NextResponse.json({ ok: false, error: `Connection testing is not available for ${config.engine} yet.` })
    }

    // When the on-site Open Dental bridge is configured (deployed site), the
    // database lives behind the tunnel — test the bridge + its database instead
    // of trying to reach the LAN host directly.
    const bridge = await odBridgeConfig(user.uid, secretsSnap.data()?.secrets)
    if (bridge) {
      try {
        const res = await fetch(bridge.url + '/od/info', {
          headers: { Authorization: `Bearer ${bridge.token}` },
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        })
        const body = await res.json().catch(() => ({}))
        if (res.ok && body.ok) {
          let host = bridge.url
          try { host = new URL(bridge.url).host } catch {}
          return NextResponse.json({ ok: true, bridge: true, host, database: body.database, version: body.version, tables: body.tables })
        }
        const code = body?.error?.code || ''
        const friendly = code === 'ER_ACCESS_DENIED_ERROR' ? 'The bridge reached MySQL but the credentials in its config.json were rejected.'
          : code === 'ER_BAD_DB_ERROR' ? 'The database named in the bridge config.json does not exist.'
          : body?.error?.message || 'The bridge is up but its MySQL connection failed — check config.json on the practice machine.'
        return NextResponse.json({ ok: false, bridge: true, error: friendly, code })
      } catch {
        return NextResponse.json({ ok: false, bridge: true, error: 'Could not reach the on-site bridge — confirm the bridge is running and the tunnel is up.' })
      }
    }

    const password = decryptSecret(secretsSnap.data()?.secrets?.[secretKeyFor(name)])
    if (!password) return NextResponse.json({ ok: false, error: 'No password saved for this connector yet. Enter one and save first.' })

    const mysql = await import('mysql2/promise')
    const host = config.host || '127.0.0.1'
    const port = Number(config.port) || 3306
    try {
      const conn = await mysql.createConnection({ host, port, user: config.user || 'root', password, database: config.database || undefined, connectTimeout: 5000, ssl: config.ssl ? {} : undefined })
      const [[row]] = await conn.query('SELECT VERSION() AS version, DATABASE() AS db')
      const [[tables]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [config.database])
      await conn.end()
      return NextResponse.json({ ok: true, host, port, database: row.db, version: row.version, tables: tables.n })
    } catch (err) {
      const code = err?.code || ''
      const friendly = code === 'ER_ACCESS_DENIED_ERROR' ? 'Access denied — check the MySQL user and password.'
        : code === 'ER_BAD_DB_ERROR' ? `Database "${config.database}" does not exist on ${host}.`
        : code === 'ECONNREFUSED' ? `Nothing is listening on ${host}:${port} — is the database service running?`
        : code === 'ETIMEDOUT' ? `Connection to ${host}:${port} timed out.` : err?.message || 'Connection failed.'
      return NextResponse.json({ ok: false, error: friendly, code })
    }
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ ok: false, error: 'Connection test failed.' }, { status: 500 })
  }
}
