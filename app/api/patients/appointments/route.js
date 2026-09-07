import { NextResponse } from 'next/server'
import { adminAuth } from '../../../../lib/firebase-admin'
import { openDentalConnection, dbError } from '../../../../lib/opendental'

export const runtime = 'nodejs'

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

// Upcoming scheduled appointments for one patient + the practice's appointment
// confirmation statuses (Open Dental keeps these as user-editable definitions).
export async function GET(request) {
  try {
    const user = await userFrom(request)
    const { searchParams } = new URL(request.url)
    const patient = Number(searchParams.get('patient'))
    if (!Number.isInteger(patient) || patient <= 0) return NextResponse.json({ error: 'A valid patient id is required.' }, { status: 400 })

    const opened = await openDentalConnection(user.uid)
    if (opened.error) return NextResponse.json({ error: opened.error }, { status: opened.status })
    const { conn } = opened
    try {
      const [appts] = await conn.query(
        `SELECT a.AptNum AS id, a.AptDateTime AS dateTime, a.Confirmed AS confirmed,
            NULLIF(a.ProcDescript, '') AS procedures, NULLIF(a.Note, '') AS note
           FROM appointment a WHERE a.PatNum = ? AND a.AptStatus = 1
           ORDER BY a.AptDateTime ASC LIMIT 5`,
        [patient],
      )
      const [defs] = await conn.query(
        `SELECT DefNum AS code, ItemName AS name FROM definition WHERE Category = 2 AND IsHidden = 0 ORDER BY ItemOrder`,
      )
      const statusNames = Object.fromEntries(defs.map((d) => [d.code, d.name]))
      const appointments = appts.map((a) => ({
        id: a.id,
        dateTime: a.dateTime,
        procedures: a.procedures || '',
        note: a.note || '',
        confirmedCode: a.confirmed,
        confirmedStatus: statusNames[a.confirmed] || `Unknown (${a.confirmed})`,
      }))
      return NextResponse.json({ appointments, confirmOptions: defs })
    } finally {
      await conn.end().catch(() => {})
    }
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: dbError(e) }, { status: 500 })
  }
}

// Mark one of the patient's appointments with a confirmation status.
export async function PATCH(request) {
  try {
    const user = await userFrom(request)
    const body = await request.json()
    const patient = Number(body.patient)
    const appointment = Number(body.appointment)
    const confirmedCode = Number(body.confirmedCode)
    if (!Number.isInteger(patient) || !Number.isInteger(appointment) || !Number.isInteger(confirmedCode)) {
      return NextResponse.json({ error: 'Patient, appointment, and confirmation code are required.' }, { status: 400 })
    }

    const opened = await openDentalConnection(user.uid)
    if (opened.error) return NextResponse.json({ error: opened.error }, { status: opened.status })
    const { conn } = opened
    try {
      const [valid] = await conn.query('SELECT DefNum FROM definition WHERE DefNum = ? AND Category = 2 AND IsHidden = 0', [confirmedCode])
      if (!valid.length) return NextResponse.json({ error: 'That confirmation status does not exist in Open Dental.' }, { status: 400 })
      const [result] = await conn.query('UPDATE appointment SET Confirmed = ? WHERE AptNum = ? AND PatNum = ?', [confirmedCode, appointment, patient])
      if (!result.affectedRows) return NextResponse.json({ error: 'Appointment not found for this patient.' }, { status: 404 })
      const [[row]] = await conn.query('SELECT AptNum AS id, AptDateTime AS dateTime, Confirmed AS confirmedCode, NULLIF(ProcDescript,\'\') AS procedures FROM appointment WHERE AptNum = ?', [appointment])
      const [[def]] = await conn.query('SELECT ItemName AS name FROM definition WHERE DefNum = ?', [confirmedCode])
      return NextResponse.json({ appointment: { ...row, confirmedStatus: def.name } })
    } finally {
      await conn.end().catch(() => {})
    }
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    return NextResponse.json({ error: dbError(e) }, { status: 500 })
  }
}
