import { NextResponse } from 'next/server'
import { adminAuth } from '../../../lib/firebase-admin'
import { openDentalConnection, dbError } from '../../../lib/opendental'

export const runtime = 'nodejs'

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

const PATIENT_SELECT = `SELECT p.PatNum AS id, p.FName AS firstName, p.LName AS lastName,
    TRIM(CONCAT(p.FName, ' ', p.LName)) AS name,
    NULLIF(p.WirelessPhone, '') AS wireless, NULLIF(p.HmPhone, '') AS home, NULLIF(p.WkPhone, '') AS work,
    NULLIF(p.Email, '') AS email, NULLIF(p.Address, '') AS addr1, NULLIF(p.Address2, '') AS addr2,
    NULLIF(p.City, '') AS city, NULLIF(p.State, '') AS state, NULLIF(p.Zip, '') AS zip,
    NULLIF(TRIM(CONCAT_WS(' | ', NULLIF(p.AddrNote, ''), NULLIF(pn.ApptPhone, ''))), '') AS notes,
    NULLIF(p.AddrNote, '') AS addrNote,
    (SELECT GROUP_CONCAT(DISTINCT c.CarrierName SEPARATOR ', ')
       FROM inssub i JOIN insplan pl ON pl.PlanNum = i.PlanNum JOIN carrier c ON c.CarrierNum = pl.CarrierNum
      WHERE i.Subscriber IN (p.PatNum, p.Guarantor)) AS insurance
  FROM patient p
  LEFT JOIN patientnote pn ON pn.PatNum = p.PatNum`

function shapePatient(r) {
  return {
    id: r.id,
    name: r.name || `(patient ${r.id})`,
    firstName: r.firstName || '',
    lastName: r.lastName || '',
    phone: r.wireless || r.home || r.work || '',
    wirelessPhone: r.wireless || '',
    homePhone: r.home || '',
    workPhone: r.work || '',
    email: r.email || '',
    insurance: r.insurance || '',
    address: [r.addr1, r.addr2, r.city, r.state, r.zip].filter(Boolean).join(', '),
    address1: r.addr1 || '',
    address2: r.addr2 || '',
    city: r.city || '',
    state: r.state || '',
    zip: r.zip || '',
    notes: (r.notes || '').slice(0, 500),
    addrNote: r.addrNote || '',
  }
}

// Pull patients from the practice's configured MySQL / MariaDB connector
// (Open Dental's live database), 50 at a time, alphabetical by last name.
export async function GET(request) {
  try {
    const user = await userFrom(request)
    const { searchParams } = new URL(request.url)
    const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 50, 1), 200)
    const offset = Math.max(Number(searchParams.get('offset')) || 0, 0)

    const opened = await openDentalConnection(user.uid)
    if (opened.error) return NextResponse.json({ error: opened.error }, { status: opened.status })
    const { conn, systemName } = opened
    try {
      const [[cnt]] = await conn.query('SELECT COUNT(*) AS n FROM patient WHERE PatStatus IN (0, 1, 2)')
      const [rows] = await conn.query(
        `${PATIENT_SELECT} WHERE p.PatStatus IN (0, 1, 2) ORDER BY p.LName, p.FName LIMIT ? OFFSET ?`,
        [limit, offset],
      )
      return NextResponse.json({ patients: rows.map(shapePatient), total: cnt.n, offset, limit, source: systemName })
    } finally {
      await conn.end().catch(() => {})
    }
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: dbError(e) }, { status: 500 })
  }
}

const clamp = (v, max) => String(v ?? '').slice(0, max).trim()
// Open Dental patient table columns we allow editing from the Patients tab.
const EDITABLE = { firstName: ['FName', 50], lastName: ['LName', 50], wirelessPhone: ['WirelessPhone', 30], homePhone: ['HmPhone', 30], workPhone: ['WkPhone', 30], email: ['Email', 100], address1: ['Address', 100], address2: ['Address2', 100], city: ['City', 50], state: ['State', 20], zip: ['Zip', 20], addressNote: ['AddrNote', 255] }

// Edit a patient's details directly in the live Open Dental database.
export async function PATCH(request) {
  try {
    const user = await userFrom(request)
    const body = await request.json()
    const id = Number(body.id)
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'A valid patient id is required.' }, { status: 400 })
    const updates = []
    const values = []
    for (const [field, [column, max]] of Object.entries(EDITABLE)) {
      if (body[field] === undefined) continue
      updates.push(`${column} = ?`)
      values.push(clamp(body[field], max))
    }
    if (!updates.length) return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 })
    values.push(id)

    const opened = await openDentalConnection(user.uid)
    if (opened.error) return NextResponse.json({ error: opened.error }, { status: opened.status })
    const { conn, systemName } = opened
    try {
      const [result] = await conn.query(`UPDATE patient SET ${updates.join(', ')} WHERE PatNum = ?`, values)
      if (!result.affectedRows) return NextResponse.json({ error: 'Patient not found in the database.' }, { status: 404 })
      const [[row]] = await conn.query(`${PATIENT_SELECT} WHERE p.PatNum = ? LIMIT 1`, [id])
      return NextResponse.json({ patient: shapePatient(row), source: systemName })
    } finally {
      await conn.end().catch(() => {})
    }
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: dbError(e) }, { status: 500 })
  }
}
