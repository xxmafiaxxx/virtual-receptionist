#!/usr/bin/env node
/**
 * Dentrix c-treeACE ODBC probe.
 *
 * Run this ON the practice server (or any PC that can reach the Dentrix DB server).
 * It finds a working ODBC connection to the c-treeACE SQL engine, then dumps the
 * full table catalog + columns to probe-report.json so the bridge config.json
 * schema mapping can be filled in.
 *
 * Usage (from the bridge folder, after `npm install`):
 *   node probe.js
 *   node probe.js --host 192.168.1.10 --service 5712 --uid ADMIN --pwd ADMIN
 *   node probe.js --dsn "Dentrix64"            (use an existing DSN)
 *   node probe.js --counts                     (also count rows per table; slower)
 *   node probe.js --driver "Exact Driver Name" --host ... --service ...
 *
 * Read-only: catalog calls only, SELECT COUNT(*) only with --counts.
 */

'use strict'

const fs = require('fs')
const { execSync } = require('child_process')

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = process.argv[i + 1]
    args[key] = next && !next.startsWith('--') ? next : true
  }
}

const HOST = args.host || 'localhost'
const SERVICE = args.service || '5712'
const UID = args.uid || 'ADMIN'
const PWD = args.pwd || 'ADMIN'
const COUNTS = Boolean(args.counts)

function registryKeys(path) {
  let out = ''
  try {
    out = execSync(`reg query "${path}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return []
  }
  const rows = []
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(.+?)\s+REG(?:_[A-Z_]+)?\s+(.*)$/)
    if (m) rows.push([m[1].trim(), m[2].trim()])
  }
  return rows
}

function installedDataSources() {
  const roots = [
    'HKLM\\SOFTWARE\\ODBC\\ODBC.INI\\ODBC Data Sources',
    'HKLM\\SOFTWARE\\WOW6432Node\\ODBC\\ODBC.INI\\ODBC Data Sources',
  ]
  return roots.flatMap((r) => registryKeys(r).map(([name, driver]) => ({ name, driver, key: r })))
}

function installedDrivers() {
  const roots = [
    'HKLM\\SOFTWARE\\ODBC\\ODBC.INI\\ODBC Drivers',
    'HKLM\\SOFTWARE\\WOW6432Node\\ODBC\\ODBC.INI\\ODBC Drivers',
  ]
  return roots.flatMap((r) => registryKeys(r).map(([name]) => name))
}

function candidateDrivers() {
  const explicit = args.driver ? [args.driver] : []
  const registry = installedDrivers()
    .filter((d) => /faircom|ctree|dentrix/i.test(d))
    .filter((d) => !/32-bit/i.test(d)) // prefer 64-bit; node is 64-bit
  const guesses = [
    'FairCom c-treeACE SQL ODBC Driver',
    'FairCom c-treeACE ODBC Driver',
    'c-treeACE ODBC Driver',
    'FairCom c-treeSQL ODBC Driver',
    'ctreeSQL ODBC Driver',
    'FairCom DB SQL ODBC Driver',
    'FairCom ODBC Driver',
  ]
  return [...new Set([...explicit, ...registry, ...guesses])]
}

async function tryConnect(odbc, connectionString) {
  try {
    const conn = await Promise.race([
      odbc.connect(connectionString),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
    ])
    return conn
  } catch {
    return null
  }
}

function dsnless(driver) {
  const u = `UID=${UID};PWD=${PWD}`
  return [
    `Driver={${driver}};Server=${HOST};Service=${SERVICE};${u}`,
    `Driver={${driver}};Host=${HOST};Port=${SERVICE};${u}`,
    `Driver={${driver}};Server=${HOST};Port=${SERVICE};${u}`,
    `Driver={${driver}};Address=${HOST}:${SERVICE};${u}`,
  ]
}

async function main() {
  let odbc
  try {
    odbc = require('odbc')
  } catch (e) {
    console.error('\nnode-odbc is not installed. Run:  npm install\n')
    process.exit(1)
  }

  console.log('Dentrix c-treeACE ODBC probe')
  console.log('============================')
  console.log(`host=${HOST} service=${SERVICE} uid=${UID}${COUNTS ? ' (with row counts)' : ''}\n`)

  const dsns = installedDataSources()
  console.log(`Found ${dsns.length} system DSN(s):`)
  dsns.forEach((d) => console.log(`  - ${d.name}  [${d.driver}]${/32-bit/i.test(d.driver) ? '  (32-bit — a 64-bit DSN is needed for this bridge)' : ''}`))
  const relevantDsns = dsns.filter((d) => /faircom|ctree|dentrix/i.test(d.driver))
  console.log('')

  const attempts = []
  for (const d of (args.dsn ? [{ name: String(args.dsn) }] : relevantDsns)) {
    attempts.push({ label: `DSN ${d.name}`, cs: `DSN=${d.name};UID=${UID};PWD=${PWD}` })
  }
  for (const driver of candidateDrivers()) {
    for (const cs of dsnless(driver)) attempts.push({ label: driver, cs })
  }

  let conn = null
  let via = null
  for (const attempt of attempts) {
    process.stdout.write(`trying ${attempt.label} ... `)
    conn = await tryConnect(odbc, attempt.cs)
    if (conn) {
      via = attempt
      console.log('CONNECTED')
      break
    }
    console.log('no')
  }

  if (!conn) {
    console.error(`
Could not connect with any candidate. Checklist:
 1. The FairCom/c-treeACE ODBC driver must be 64-bit (Node.js here is 64-bit). Check
    "ODBC Data Sources (64-bit)" > Drivers tab. If only 32-bit exists, install the 64-bit
    FairCom client driver, or run this probe with 32-bit Node.
 2. Confirm host/service. From the Dentrix server try: netstat -ano | findstr ${SERVICE}
 3. Confirm the SQL credentials (FairCom default ADMIN/ADMIN; Dentrix may differ).
 4. Pass explicit flags, e.g.:  node probe.js --host 127.0.0.1 --service 5712 --uid ADMIN --pwd ADMIN
 5. If the SQL engine is not enabled on the Dentrix c-tree server, ODBC cannot connect at all;
    that requires the Dentrix Developer Program route.
`)
    process.exit(2)
  }

  console.log(`\nConnected via: ${via.label}`)
  if (via.cs.startsWith('DSN=')) console.log('  → set  config.json > odbc.dsn  to this DSN name')
  else console.log(`  → set  config.json > odbc.dsnLess  to:  ${via.cs.replace(/PWD=[^;]+/, 'PWD=********')}`)

  const report = {
    generatedAt: new Date().toISOString(),
    connection: { host: HOST, service: SERVICE, uid: UID, via: via.label, driverHint: via.cs.replace(/PWD=[^;]+/, 'PWD=********') },
    tables: [],
  }

  let tables = []
  try {
    tables = await conn.tables(null, null, null, null)
  } catch (e) {
    console.error('Catalog (tables) call failed:', e.message)
  }
  if (!tables.length) {
    // fall back to ANSI catalog
    try {
      tables = (await conn.query('SELECT TABLE_NAME, TABLE_TYPE FROM SYSTABLES')).map((r) => ({ TABLE_NAME: r.TABLE_NAME, TABLE_TYPE: String(r.TABLE_TYPE || '').includes('VIEW') ? 'VIEW' : 'TABLE' }))
    } catch {}
  }

  console.log(`Catalog returned ${tables.length} tables/views. Dumping columns...\n`)
  const interesting = /(patient|apt|appoint|phone|addr|guarantor|recall|insur)/i
  const found = []

  for (const t of tables) {
    const name = t.TABLE_NAME || t.table_name
    if (!name) continue
    const entry = { name, type: (t.TABLE_TYPE || 'TABLE'), columns: [] }
    try {
      const cols = await conn.columns(null, null, name, null)
      entry.columns = cols.map((c) => ({ name: c.COLUMN_NAME, type: c.TYPE_NAME || String(c.DATA_TYPE), nullable: c.NULLABLE === 1 || c.NULLABLE === '1' || c.NULLABLE === true }))
    } catch (e) {
      entry.error = e.message
    }
    report.tables.push(entry)
    const hit = interesting.test(name)
    if (hit) found.push(name)
    process.stdout.write(`  ${entry.type.padEnd(6)} ${name.padEnd(40)} ${String(entry.columns.length).padStart(3)} cols${hit ? '   <-- looks relevant' : ''}\n`)
  }

  if (COUNTS && report.tables.length) {
    console.log('\nCounting rows (this may take a while on a live database)...')
    for (const t of report.tables) {
      if (t.type !== 'TABLE' || t.error) continue
      try {
        const r = await conn.query(`SELECT COUNT(*) AS N FROM "${t.name}"`)
        t.rowCount = Number(r[0]?.N ?? r[0]?.n ?? -1)
      } catch (e) {
        t.rowCount = null
      }
    }
    report.tables.forEach((t) => { if (t.rowCount !== undefined) process.stdout.write(`  ${t.name.padEnd(40)} ${t.rowCount}\n`) })
  }

  try { await conn.close() } catch {}

  const out = args.out || 'probe-report.json'
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log(`\nFull report written to ${out} (${report.tables.length} tables).`)

  console.log(`
NEXT STEP
 1. Open ${out} and find the patient table (search columns for phone/name fields)
    and the appointment table.
 2. Copy those table + column names into config.json > schema.patient / schema.appointment.
 3. Start the bridge:  npm start
${found.length ? '\nTable names that looked patient/appointment-related: ' + found.join(', ') : ''}
`)
}

main().catch((e) => {
  console.error('Probe failed:', e.message)
  process.exit(1)
})
