import { adminDb } from './firebase-admin'
import { decryptSecret } from './secret-crypto'

// Shared connector lookup for live Open Dental database access. Resolves the
// practice's MySQL / MariaDB connector (preferring "Open Dental"), decrypts the
// saved password from the integration-secrets vault, and returns a live connection.
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
