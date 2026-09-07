#!/usr/bin/env node
/**
 * Corinne Dentrix bridge — on-site read-only API in front of the practice's
 * Dentrix c-treeACE database (via the FairCom ODBC driver).
 *
 * Runs on a machine inside the practice LAN (ideally the Dentrix server).
 * Exposed to the Corinne app through an outbound-only tunnel (Cloudflare Tunnel
 * or Tailscale Funnel) — never by opening a router port.
 *
 * Endpoints (all require Authorization: Bearer <config token>):
 *   GET /                       — bridge info
 *   GET /health                 — { ok, db: { connected, error? } }
 *   GET /patients?phone=...     — lookup by phone (exact or last-10-digits)
 *   GET /patients?name=...      — search first/last name
 *   GET /patients?id=...        — single patient by id
 *   GET /patients/:id/appointments — latest appointments for one patient
 *
 * Read-only by construction: every query is a parameterized SELECT built from
 * config.json. If config.json > schema is not mapped yet, data endpoints return
 * 503 with instructions instead of guessing.
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

let odbc
try {
  odbc = require('odbc')
} catch (e) {
  console.error('The odbc package is missing. Run:  npm install')
  process.exit(1)
}

function odbcConnectionString() {
  const o = config.odbc || {}
  if (o.dsn) return `DSN=${o.dsn};UID=${o.dsnLess?.uid || 'ADMIN'};PWD=${o.dsnLess?.pwd || ''}`
  const d = o.dsnLess || {}
  if (!d.driver) return null
  return `Driver={${d.driver}};Server=${d.server || 'localhost'};Service=${d.service || '5712'};UID=${d.uid || 'ADMIN'};PWD=${d.pwd || ''}`
}

const CS = odbcConnectionString()
if (!CS) {
  console.error('config.json > odbc: set either dsn or dsnLess.driver. Run probe.js first to find a working connection.')
  process.exit(1)
}

// odbc.pool() connects eagerly and returns a Promise — create it lazily so the
// bridge still serves /health (with db disconnected) when the driver or server is down.
let pool = null
let poolError = null
async function getPool() {
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

// ---------- db helpers ----------

let lastDbCheck = { at: 0, connected: false, error: null }

async function dbStatus(force = false) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const p = url.pathname.replace(/\/+$/, '') || '/'
  const q = Object.fromEntries(url.searchParams)

  if (p === '/health') {
    const status = await dbStatus()
    return send(res, 200, { ok: true, service: 'corinne-dentrix-bridge', db: { connected: status.connected, error: status.error } })
  }

  if (!authorized(req)) {
    console.log(`${new Date().toISOString()} 401 ${p}`)
    return send(res, 401, { error: 'Unauthorized' })
  }

  console.log(`${new Date().toISOString()} 200 ${p}${Object.keys(q).length ? ' ' + JSON.stringify(q) : ''}`)

  if (p === '/') {
    const schemaReady = Boolean(patientColumnsMapped())
    return send(res, 200, {
      ok: true,
      service: 'corinne-dentrix-bridge',
      version: '1.0.0',
      schemaMapped: schemaReady,
      endpoints: ['/health', '/patients?phone=|name=|id=', '/patients/:id/appointments'],
    })
  }

  if (p === '/patients') return readUpstream(req, res, () => findPatients(q), {})

  const appt = p.match(/^\/patients\/([^/]+)\/appointments$/)
  if (appt) return readUpstream(req, res, () => patientAppointments(decodeURIComponent(appt[1])), {})

  send(res, 404, { error: 'Not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Corinne Dentrix bridge listening on http://127.0.0.1:${PORT}`)
  console.log('Expose it with an outbound-only tunnel (Cloudflare Tunnel or Tailscale Funnel).')
  console.log(`Schema mapped: patient=${Boolean(patientColumnsMapped())} appointment=${Boolean(schemaMapped('appointment'))}`)
})

async function shutdown() {
  try { if (pool) await pool.close() } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
