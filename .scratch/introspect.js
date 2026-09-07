import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
for (const line of readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
process.env.GOOGLE_APPLICATION_CREDENTIALS = fileURLToPath(new URL('../corinne--virtual-receptionist-firebase-adminsdk-fbsvc-bc6ba0e89e.json', import.meta.url))
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
initializeApp({ credential: applicationDefault() })
const db = getFirestore()
const users = await db.collection('users').listDocuments()
let cfg = null
for (const u of users) {
  const s = await u.collection('private').doc('connectors').get()
  const d = s.data()?.configs || {}
  const hit = Object.entries(d).find(([n, c]) => c && c.host && c.engine === 'MySQL / MariaDB')
  if (hit) {
    const sec = await u.collection('private').doc('integration-secrets').get()
    const key = `CONNECTOR_${hit[0].toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
    const { decryptSecret } = await import('../lib/secret-crypto.js')
    const password = decryptSecret(sec.data()?.secrets?.[key])
    if (!password) continue
    cfg = { uid: u.id, name: hit[0], ...hit[1], password }
    break
  }
}
if (!cfg || !cfg.password) { console.log('NO CONNECTOR/PASSWORD'); process.exit(1) }
console.log('connector:', cfg.name, cfg.host + ':' + cfg.port, 'db=' + cfg.database)
const mysql = await import('mysql2/promise')
const conn = await mysql.createConnection({ host: cfg.host, port: Number(cfg.port) || 3306, user: cfg.user || 'root', password: cfg.password, database: cfg.database, connectTimeout: 5000 })
const show = async (label, sql, params) => { try { const [rows] = await conn.query(sql, params); console.log('---', label); console.log(rows.length > 20 ? rows.slice(0, 20) : rows) } catch (e) { console.log('---', label, 'ERR', e.code || e.message) } }
await show('recall columns', "SHOW COLUMNS FROM recall")
await show('recall count', "SELECT COUNT(*) n FROM recall")
await show('recall sample', "SELECT RecallNum, PatNum, DateDue, DateScheduled, RecallStatus, RecallTypeNum FROM recall ORDER BY DateDue ASC LIMIT 10")
await show('recalltype', "SELECT * FROM recalltype")
await show('procedurelog ProcStatus distinct', "SELECT DISTINCT ProcStatus, COUNT(*) n FROM procedurelog GROUP BY ProcStatus")
await show('insverify columns', "SHOW COLUMNS FROM insverify")
await show('insverify sample', "SELECT * FROM insverify LIMIT 5")
await show('insverifytypes', "SELECT * FROM insverifytype")
await show('definition categories', "SELECT Category, GROUP_CONCAT(ItemName SEPARATOR ' | ') names FROM definition GROUP BY Category ORDER BY Category")
await show('appointment Confirmed of scheduled', "SELECT a.Confirmed, d.ItemName, COUNT(*) n FROM appointment a LEFT JOIN definition d ON d.DefNum=a.Confirmed AND d.Category=2 WHERE a.AptStatus=1 GROUP BY a.Confirmed, d.ItemName")
await show('treatment planned sample', "SELECT pl.PatNum, COUNT(*) n, SUM(pl.ProcFee) total FROM procedurelog pl WHERE pl.ProcStatus=1 GROUP BY pl.PatNum ORDER BY n DESC LIMIT 10")
await conn.end()
process.exit(0)
