#!/usr/bin/env node
/**
 * Corinne on-site bridge — small authenticated HTTPS service that runs inside
 * the practice LAN, next to the practice databases, and exposes them to the
 * deployed Corinne app through an outbound-only tunnel (Cloudflare Tunnel or
 * Tailscale Funnel) — never by opening a router port.
 *
 * Two engines, either or both enabled via config.json:
 *
 *   mysql (Open Dental)   config.json > mysql   — forwards the app's parameterized
 *     MySQL / MariaDB queries so every Open Dental feature (patients, appointments,
 *     insurance pulls, practice sync, task analyzer, agent write-back) works from
 *     the deployed site exactly as it does on the LAN. Writes are allowed: the app
 *     edits patients and records call results. The token therefore carries
 *     database-level power — keep it long, random, and private.
 *
 *   odbc (Dentrix)        config.json > odbc + schema — read-only patient /
 *     appointment lookups against the Dentrix c-treeACE database via FairCom's
 *     ODBC driver. Read-only by construction: every query is a parameterized
 *     SELECT built from the schema mapping. Until schema is mapped, Dentrix
 *     endpoints return 503 with instructions instead of guessing.
 *
 * Endpoints (all except /health require Authorization: Bearer <config token>):
 *   GET  /health                — { ok, service, dentrix: {…}, mysql: {…} } (tokenless)
 *   GET  /                      — bridge info
 *   POST /od/query              — { sql, params } → { ok, kind, rows?|result?, fields? }
 *   GET  /od/info               — { ok, version, database, tables }
 *   GET  /patients?phone=|name=|id= and /patients/:id/appointments — Dentrix
 */

'use strict'

const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, 'config.json')
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('config.json not found. Copy config.example.json to config.json and fill it in.')
  process.exit(1)
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))

if (!config.token || /GENERATE-A-LONG-RANDOM/.test(config.token)) {
  console.error('config.json > token is not set. Generate one with:')
  console.error(`  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
  process.exit(1)
}
const TOKEN = Buffer.from(config.token)
const PORT = Number(config.port || 8787)

// ---------- Dentrix (c-treeACE over ODBC) — optional ----------

function schemaMapped(entry) {
  const s = config.schema && config.schema[entry]
  if (!s || !s.table || !s.id) return null
  return s
}

function patientColumnsMapped() {
  const s = schemaMapped('patient')
  if (!s || !s.phone) return null
  return s
}

const HAS_DENTRIX = Boolean(config.odbc && (config.odbc.dsn || (config.odbc.dsnLess && config.odbc.dsnLess.driver)))

let odbc = null
let pool = null
let poolError = null

if (HAS_DENTRIX) {
  try {
    odbc = require('odbc')
  } catch (e) {
    console.error('The odbc package is missing. Run:  npm install')
    process.exit(1)
  }
}

function odbcConnectionString() {
  const o = config.odbc || {}
  if (o.dsn) return `DSN=${o.dsn};UID=${o.dsnLess?.uid || 'ADMIN'};PWD=${o.dsnLess?.pwd || ''}`
  const d = o.dsnLess || {}
  if (!d.driver) return null
  return `Driver={${d.driver}};Server=${d.server || 'localhost'};Service=${d.service || '5712'};UID=${d.uid || 'ADMIN'};PWD=${d.pwd || ''}`
}

const CS = HAS_DENTRIX ? odbcConnectionString() : null
if (HAS_DENTRIX && !CS) {
  console.error('config.json > odbc: set either dsn or dsnLess.driver. Run probe.js first to find a working connection.')
  process.exit(1)
}

// odbc.pool() connects eagerly and returns a Promise — create it lazily so the
// bridge still serves /health (with db disconnected) when the driver or server is down.
async function getPool() {
  if (!HAS_DENTRIX) return null
  if (pool) return pool
  try {
    pool = await odbc.pool({ connectionString: CS, connectionTimeout: 8, loginTimeout: 8 })
    poolError = null
  } catch (e) {
    poolError = e?.message || 'ODBC pool creation failed'
    pool = null
  }
  return pool
}

// ---------- Open Dental (MySQL / MariaDB) — optional ----------

const HAS_MYSQL = Boolean(config.mysql && config.mysql.host)

let mysql = null
let odPool = null

if (HAS_MYSQL) {
  try {
    mysql = require('mysql2/promise')
  } catch (e) {
    console.error('The mysql2 package is missing. Run:  npm install')
    process.exit(1)
  }
  // dateStrings keeps DATE/DATETIME/TIMESTAMP as the server sent them so we can
  // convert to ISO in this machine's timezone (= the practice's timezone);
  // multipleStatements stays off so stacked statements are rejected server-side.
  odPool = mysql.createPool({
    host: config.mysql.host || '127.0.0.1',
    port: Number(config.mysql.port) || 3306,
    user: config.mysql.user || 'root',
    password: config.mysql.password || '',
    database: config.mysql.database || undefined,
    connectionLimit: 4,
    connectTimeout: 5000,
    dateStrings: true,
    multipleStatements: false,
  })
}

if (!HAS_DENTRIX && !HAS_MYSQL) {
  console.error('config.json has no engine enabled. Fill in either the mysql block (Open Dental) or the odbc block (Dentrix).')
  process.exit(1)
}

// MySQL field type codes for DATE / DATETIME / TIMESTAMP / NEWDATE (+8-byte variants)
const OD_DATE_TYPES = new Set([7, 10, 12, 14, 17, 18])

// JSON-safe row shaping for /od/query. Buffers (MySQL BIT) become numbers,
// date strings become ISO timestamps interpreted in this machine's timezone —
// the bridge runs in the practice, so that matches what the database means.
function cleanOdRow(row, fields) {
  const dateNames = new Set((fields || []).filter((f) => OD_DATE_TYPES.has(f.type)).map((f) => f.name))
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (Buffer.isBuffer(v)) { out[k] = v.length === 1 ? v[0] : v.toString('hex'); continue }
    if (v instanceof Date) { out[k] = v.toISOString(); continue }
    if (dateNames.has(k) && typeof v === 'string') {
      const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/)
      if (m) {
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0))
        out[k] = isNaN(d.getTime()) ? v : d.toISOString()
        continue
      }
    }
    out[k] = v === undefined ? null : v
  }
  return out
}

async function odQuery(body) {
  const sql = typeof body?.sql === 'string' ? body.sql : ''
  if (!sql.trim()) return { badRequest: 'sql is required.' }
  if (sql.length > 65536) return { badRequest: 'sql is too long.' }
  const params = Array.isArray(body?.params) ? body.params.slice(0, 200) : []
  const [result, fields] = await odPool.query(sql, params)
  if (Array.isArray(result)) {
    const cleanFields = (fields || []).map((f) => ({ name: f.name, type: f.type }))
    return { kind: 'rows', rows: result.map((r) => cleanOdRow(r, fields)), fields: cleanFields }
  }
  return {
    kind: 'result',
    result: { affectedRows: result.affectedRows, insertId: result.insertId, changedRows: result.changedRows },
  }
}

async function odInfo() {
  const [[v]] = await odPool.query('SELECT VERSION() AS version, DATABASE() AS db')
  const [[t]] = await odPool.query('SELECT COUNT(*) AS tables FROM information_schema.tables WHERE table_schema = DATABASE()')
  return { version: v.version, database: v.db, tables: t.tables }
}

// ---------- status checks ----------

let lastDbCheck = { at: 0, connected: false, error: null }

async function dbStatus(force = false) {
  if (!HAS_DENTRIX) return { connected: false, error: 'not configured' }
  if (!force && Date.now() - lastDbCheck.at < 30000) return lastDbCheck
  const p = await getPool()
  if (!p) {
    lastDbCheck = { at: Date.now(), connected: false, error: poolError }
    return lastDbCheck
  }
  try {
    await p.query('SELECT COUNT(*) AS N FROM SYSTABLES')
    lastDbCheck = { at: Date.now(), connected: true, error: null }
  } catch (e) {
    lastDbCheck = { at: Date.now(), connected: false, error: e.message }
  }
  return lastDbCheck
}

let lastOdCheck = { at: 0, connected: false, error: null }

async function odStatus(force = false) {
  if (!HAS_MYSQL) return { connected: false, error: 'not configured' }
  if (!force && Date.now() - lastOdCheck.at < 30000) return lastOdCheck
  try {
    await Promise.race([odPool.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))])
    lastOdCheck = { at: Date.now(), connected: true, error: null }
  } catch (e) {
    lastOdCheck = { at: Date.now(), connected: false, error: e.message }
  }
  return lastOdCheck
}

async function q(sql, params) {
  const p = await getPool()
  if (!p) throw new Error(poolError || 'database unavailable')
  return p.query(sql, params)
}

const digits = (s) => String(s || '').replace(/\D+/g, '')

function selectFor(schema, params) {
  const cols = Object.entries(schema)
    .filter(([alias, col]) => col && !['table'].includes(alias))
    .map(([alias, col]) => `"${col}" AS ${alias}`)
  return `SELECT ${cols.join(', ')} FROM "${schema.table}"`
}

async function findPatients(query) {
  const s = patientColumnsMapped()
  if (!s) return { unmapped: true }
  const params = []
  let where = ''
  if (query.phone) {
    const d = digits(query.phone)
    const last10 = d.slice(-10)
    params.push(d, `%${last10}`)
    where = `WHERE "${s.phone}" = ? OR "${s.phone}" LIKE ?`
  } else if (query.name) {
    const like = `%${String(query.name).toLowerCase()}%`
    if (s.firstName && s.lastName) {
      params.push(like, like, like)
      where = `WHERE LOWER("${s.firstName}") LIKE ? OR LOWER("${s.lastName}") LIKE ? OR LOWER("${s.firstName}" || ' ' || "${s.lastName}") LIKE ?`
    } else if (s.firstName) {
      params.push(like)
      where = `WHERE LOWER("${s.firstName}") LIKE ?`
    } else {
      params.push(like)
      where = `WHERE LOWER("${s.lastName}") LIKE ?`
    }
  } else if (query.id) {
    params.push(query.id)
    where = `WHERE "${s.id}" = ?`
  } else {
    // browse mode: paged alphabetical listing (mirrors the app's patient directory)
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200)
    const offset = Math.max(Number(query.offset) || 0, 0)
    const nameOrder = [s.lastName, s.firstName].filter(Boolean).map((c) => `"${c}"`).join(', ')
    const sql = `${selectFor(s)}${nameOrder ? ` ORDER BY ${nameOrder}` : ''}`
    const [rows, countRow] = await Promise.all([
      q(sql),
      q(`SELECT COUNT(*) AS N FROM "${s.table}"`).catch(() => [{ N: -1 }]),
    ])
    return { rows: rows.slice(offset, offset + limit).map(cleanRow), total: Number(countRow[0]?.N ?? -1), offset, limit }
  }

  const sql = `${selectFor(s)} ${where}`
  const rows = await q(sql, params)
  return { rows: rows.slice(0, 50).map(cleanRow) }
}

async function patientAppointments(patientId) {
  const s = schemaMapped('appointment')
  const p = patientColumnsMapped()
  if (!s) return { unmapped: true }
  const params = [patientId]
  const orderCols = [s.date, s.time].filter(Boolean).map((c) => `"${c}"`).join(', ')
  const sql = `${selectFor(s)} WHERE "${s.patientId}" = ?${orderCols ? ` ORDER BY ${orderCols} DESC` : ''}`
  const rows = await q(sql, params)
  const appts = rows.slice(0, 20).map(cleanRow)
  // enrich with patient name when available
  let patient = null
  if (p) {
    try {
      const r = await q(`${selectFor(p)} WHERE "${p.id}" = ?`, [patientId])
      if (r[0]) patient = cleanRow(r[0])
    } catch {}
  }
  return { rows: appts, patient }
}

function cleanRow(row) {
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue
    out[k] = v instanceof Date ? v.toISOString() : v
  }
  return out
}

// ---------- http plumbing ----------

function send(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) })
  res.end(json)
}

function authorized(req) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice(7))
  return given.length === TOKEN.length && crypto.timingSafeEqual(given, TOKEN)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

async function readUpstream(req, res, upstream, extra) {
  try {
    const result = await upstream()
    if (result.unmapped) {
      return send(res, 503, {
        error: 'Bridge schema is not mapped yet. Run probe.js on this machine, then fill config.json > schema with the real Dentrix table/column names from probe-report.json.',
      })
    }
    if (result.badRequest) return send(res, 400, { error: result.badRequest })
    return send(res, 200, { ok: true, ...extra, ...result })
  } catch (e) {
    console.error('db error:', e.message)
    return send(res, 502, { ok: false, error: 'Database query failed: ' + e.message })
  }
}

async function handleOdQuery(req, res) {
  const body = await readBody(req)
  try {
    const result = await odQuery(body)
    if (result.badRequest) return send(res, 400, { ok: false, error: { message: result.badRequest } })
    return send(res, 200, { ok: true, ...result })
  } catch (e) {
    // Surface the real MySQL error code (ER_ACCESS_DENIED_ERROR, ER_BAD_DB_ERROR,
    // …) so the app's friendly messages keep working through the bridge.
    return send(res, 500, { ok: false, error: { code: e.code || 'ER_UNKNOWN', errno: e.errno, sqlMessage: e.sqlMessage || e.message, message: e.message } })
  }
}

async function handleOdInfo(req, res) {
  try {
    const info = await odInfo()
    return send(res, 200, { ok: true, ...info })
  } catch (e) {
    return send(res, 500, { ok: false, error: { code: e.code || 'ER_UNKNOWN', errno: e.errno, sqlMessage: e.sqlMessage || e.message, message: e.message } })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const p = url.pathname.replace(/\/+$/, '') || '/'
  const q = Object.fromEntries(url.searchParams)

  if (p === '/health') {
    const [dentrix, mysqlStatus] = await Promise.all([dbStatus(), odStatus()])
    const body = { ok: true, service: 'corinne-bridge' }
    if (HAS_DENTRIX) body.dentrix = { connected: dentrix.connected, error: dentrix.error }
    if (HAS_MYSQL) body.mysql = { connected: mysqlStatus.connected, error: mysqlStatus.error }
    // legacy field for the app's Dentrix status card
    if (HAS_DENTRIX) body.db = { connected: dentrix.connected, error: dentrix.error }
    return send(res, 200, body)
  }

  if (!authorized(req)) {
    console.log(`${new Date().toISOString()} 401 ${p}`)
    return send(res, 401, { error: 'Unauthorized' })
  }

  console.log(`${new Date().toISOString()} 200 ${p}${Object.keys(q).length ? ' ' + JSON.stringify(q) : ''}`)

  if (p === '/') {
    const endpoints = ['/health']
    if (HAS_MYSQL) endpoints.push('/od/query (POST)', '/od/info')
    if (HAS_DENTRIX) endpoints.push('/patients?phone=|name=|id=', '/patients/:id/appointments')
    return send(res, 200, {
      ok: true,
      service: 'corinne-bridge',
      version: '1.1.0',
      engines: { openDental: HAS_MYSQL, dentrix: HAS_DENTRIX },
      schemaMapped: Boolean(patientColumnsMapped()),
      endpoints,
    })
  }

  if (p === '/od/query') {
    if (!HAS_MYSQL) return send(res, 503, { error: 'MySQL engine is not configured on this bridge. Fill config.json > mysql.' })
    return handleOdQuery(req, res)
  }
  if (p === '/od/info') {
    if (!HAS_MYSQL) return send(res, 503, { error: 'MySQL engine is not configured on this bridge. Fill config.json > mysql.' })
    return handleOdInfo(req, res)
  }

  if (p === '/patients') return readUpstream(req, res, () => findPatients(q), {})

  const appt = p.match(/^\/patients\/([^/]+)\/appointments$/)
  if (appt) return readUpstream(req, res, () => patientAppointments(decodeURIComponent(appt[1])), {})

  send(res, 404, { error: 'Not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Corinne bridge listening on http://127.0.0.1:${PORT}`)
  console.log('Expose it with an outbound-only tunnel (Cloudflare Tunnel or Tailscale Funnel).')
  console.log(`Engines: openDental=${HAS_MYSQL ? 'on' : 'off'} dentrix=${HAS_DENTRIX ? 'on' : 'off'}`)
  if (HAS_DENTRIX) console.log(`Schema mapped: patient=${Boolean(patientColumnsMapped())} appointment=${Boolean(schemaMapped('appointment'))}`)
})

async function shutdown() {
  try { if (pool) await pool.close() } catch {}
  try { if (odPool) await odPool.end() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
