import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'
import { decryptSecret } from '../../../../lib/secret-crypto'

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
