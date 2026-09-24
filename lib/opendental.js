import { adminDb } from './firebase-admin'
import { decryptSecret } from './secret-crypto'

const BRIDGE_TIMEOUT_MS = 30000

// Open Dental database access happens one of two ways:
//   direct — the app runs on the practice LAN (local dev), mysql2 straight to the
//            host saved in the user's connector config;
//   bridge — the deployed app (Vercel) cannot reach the LAN, so queries route
//            through the on-site bridge (bridge/ in this repo): a small HTTPS
//            service next to the database, exposed via an outbound-only tunnel.
// Bridge URL/token come from env (site-wide) or the user's encrypted secrets
// (per-user override, saved from Admin → Connectors → Open Dental).
export async function odBridgeConfig(uid, preloadedSecrets) {
  let url = process.env.OPEN_DENTAL_BRIDGE_URL || ''
  let token = process.env.OPEN_DENTAL_BRIDGE_TOKEN || ''
  try {
    let secrets = preloadedSecrets
    if (!secrets) {
      const snap = await adminDb.doc(`users/${uid}/private/integration-secrets`).get()
      secrets = snap.data()?.secrets || {}
    }
    url = decryptSecret(secrets.odBridgeUrl) || url
    token = decryptSecret(secrets.odBridgeToken) || token
  } catch {}
  url = String(url || '').trim().replace(/\/+$/, '')
  token = String(token || '').trim()
  return url && token ? { url, token } : null
}

// Date-ish MySQL column types (TIMESTAMP, DATE, DATETIME, NEWDATE + the
// "2" 8-byte variants). The bridge sends these as ISO strings (interpreted in
// the practice's timezone, where the bridge runs); revive them so consumers
// see the same Date objects a direct mysql2 connection returns.
const DATE_TYPES = new Set([7, 10, 12, 14, 17, 18])

function reviveRows(rows, fields) {
  if (!Array.isArray(fields) || !fields.length) return rows
  const dateCols = fields.filter((f) => f && DATE_TYPES.has(f.type) && f.name != null).map((f) => f.name)
  if (!dateCols.length) return rows
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row
    const out = { ...row }
    for (const col of dateCols) {
      const v = out[col]
      if (typeof v === 'string' && v) {
        const d = new Date(v)
        if (!isNaN(d.getTime())) out[col] = d
      }
    }
    return out
  })
}

function bridgeFetchError(e) {
  const err = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    ? new Error('The on-site Open Dental bridge timed out — the tunnel or database may be busy or down.')
    : new Error('Could not reach the on-site Open Dental bridge — confirm the bridge is running on the practice machine and the tunnel is up.')
  err.code = 'BRIDGE_UNREACHABLE'
  return err
}

function bridgeQueryError(body) {
  const e = body?.error
  const detail = e && typeof e === 'object' ? e : {}
  const err = new Error(detail.sqlMessage || detail.message || 'Open Dental bridge error.')
  err.code = detail.code || 'BRIDGE_ERROR'
  err.errno = detail.errno
  err.sqlMessage = detail.sqlMessage
  return err
}

// mysql2-compatible surface over the bridge: conn.query(sql, params) resolves
// [rows, fields] for SELECTs and [resultHeader] for writes; conn.end() is a
// no-op — every query is its own HTTPS round trip, so routes work unchanged.
function bridgeConn(bridge) {
  return {
    query: async (sql, params) => {
      let res
      try {
        res = await fetch(bridge.url + '/od/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.token}` },
          body: JSON.stringify({ sql, params: Array.isArray(params) ? params : params === undefined ? [] : [params] }),
          cache: 'no-store',
          signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
        })
      } catch (e) {
        throw bridgeFetchError(e)
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body?.ok) throw bridgeQueryError(body)
      if (body.kind === 'result') {
        const r = body.result || {}
        return [{ affectedRows: r.affectedRows || 0, insertId: r.insertId || 0, changedRows: r.changedRows || 0 }, undefined]
      }
      return [reviveRows(body.rows || [], body.fields), []]
    },
    end: async () => {},
  }
}

// Shared connector lookup for live Open Dental database access. Resolves the
// practice's MySQL / MariaDB connector (preferring "Open Dental"), then returns
// either a bridge-backed client (when the on-site bridge is configured) or a
// direct mysql2 connection using the password decrypted from the vault.
export async function openDentalConnection(uid) {
  const [connSnap, secretsSnap] = await Promise.all([
    adminDb.doc(`users/${uid}/private/connectors`).get(),
    adminDb.doc(`users/${uid}/private/integration-secrets`).get(),
  ])
  const configs = connSnap.data()?.configs || {}
  const entries = Object.entries(configs).sort(([a], [b]) => (a === 'Open Dental' ? -1 : b === 'Open Dental' ? 1 : 0))
  const match = entries.find(([, c]) => c && c.host && c.engine === 'MySQL / MariaDB')
  if (!match) return { error: 'No MySQL / MariaDB connector configured yet. Add it under Settings → Connectors.', status: 409 }
  const [systemName, cfg] = match

  const bridge = await odBridgeConfig(uid, secretsSnap.data()?.secrets)
  if (bridge) return { conn: bridgeConn(bridge), cfg, systemName: `${systemName} (via bridge)` }

  const secretKey = `CONNECTOR_${String(systemName).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
  const password = decryptSecret(secretsSnap.data()?.secrets?.[secretKey])
  if (!password) return { error: `No password saved for the ${systemName} connector yet. Add it under Settings → Connectors.`, status: 409 }
  const mysql = await import('mysql2/promise')
  const conn = await mysql.createConnection({
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port) || 3306,
    user: cfg.user || 'root',
    password,
    database: cfg.database || undefined,
    connectTimeout: 5000,
    ssl: cfg.ssl ? {} : undefined,
  })
  return { conn, cfg, systemName }
}

export function dbError(e) {
  const code = e?.code || ''
  return code === 'ER_ACCESS_DENIED_ERROR' ? 'The database rejected the saved credentials — check the connector password.'
    : code === 'ER_BAD_DB_ERROR' ? 'The configured database does not exist on this server — check the connector settings.'
    : code === 'ECONNREFUSED' || code === 'ETIMEDOUT' ? 'Could not reach the database server — is Open Dental\'s MySQL service running?'
    : code === 'ER_NO_SUCH_TABLE' ? 'This database is missing expected Open Dental tables — is it pointed at the right database?'
    : code === 'ER_BAD_FIELD_ERROR' ? 'This database does not match the expected Open Dental schema — check which connector and database is configured.'
    : e?.sqlMessage || e?.message || 'Database error.'
}
