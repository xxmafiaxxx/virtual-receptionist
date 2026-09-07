import { adminDb } from './firebase-admin'
import { openDentalConnection, dbError } from './opendental'

// Canonical practice settings for a practice account. Lived in localStorage demo
// arrays before; now server-side (users/{uid}/private/practice) so call flows and
// the future inbound agent read the same truth. Populated manually or synced from
// the practice database (Open Dental today, Dentrix bridge when its schema maps).

export const PRACTICE_DEFAULTS = {
  source: 'manual',
  syncedAt: null,
  practice: { name: '', phone: '', address1: '', address2: '', city: '', state: '', zip: '' },
  operatories: [], // { id, name, abbrev, hygiene }
  doctors: [],     // { id, name, display, abbrev, npi, specialty }
  staff: [],       // { id, name, phoneExt, email }
}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max)
const digits = (v) => String(v ?? '').replace(/\D+/g, '')

// Practice settings are per-account (users/{uid}/private/practice). Only the
// insurance payer list is shared across users (practices/{PRACTICE_ID}).
export function practiceDoc(uid) {
  return adminDb.doc(`users/${uid}/private/practice`)
}

export async function getPracticeSettings(uid) {
  const snap = await practiceDoc(uid).get()
  return normalize({ ...PRACTICE_DEFAULTS, ...(snap.data() || {}) })
}

function normalize(p = {}) {
  const clean = {
    source: str(p.source, 20) || 'manual',
    syncedAt: p.syncedAt || null,
    practice: { ...PRACTICE_DEFAULTS.practice, ...(p.practice || {}) },
    operatories: Array.isArray(p.operatories) ? p.operatories.slice(0, 100) : [],
    doctors: Array.isArray(p.doctors) ? p.doctors.slice(0, 100) : [],
    staff: Array.isArray(p.staff) ? p.staff.slice(0, 200) : [],
  }
  clean.practice = {
    name: str(clean.practice.name, 120),
    phone: str(clean.practice.phone, 30),
    address1: str(clean.practice.address1, 120),
    address2: str(clean.practice.address2, 120),
    city: str(clean.practice.city, 60),
    state: str(clean.practice.state, 20),
    zip: str(clean.practice.zip, 20),
  }
  clean.operatories = clean.operatories.map((o, i) => ({ id: o.id ?? i + 1, name: str(o.name, 80), abbrev: str(o.abbrev, 20), hygiene: Boolean(o.hygiene) }))
  clean.doctors = clean.doctors.map((d, i) => ({ id: d.id ?? i + 1, name: str(d.name, 80), display: str(d.display, 80), abbrev: str(d.abbrev, 20), npi: digits(d.npi).slice(0, 15), specialty: str(d.specialty, 60) }))
  clean.staff = clean.staff.map((s, i) => ({ id: s.id ?? i + 1, name: str(s.name, 80), phoneExt: str(s.phoneExt, 10), email: str(s.email, 120) }))
  return clean
}

export async function savePracticeSettings(uid, patch) {
  const current = await getPracticeSettings(uid)
  const merged = normalize({ ...current, ...patch, practice: { ...current.practice, ...(patch?.practice || {}) } })
  // manual edits keep the existing provenance; only a database sync changes source/syncedAt
  merged.source = patch?.source || current.source
  merged.syncedAt = patch?.syncedAt ?? current.syncedAt
  await practiceDoc(uid).set(merged)
  return merged
}

// Pull practice identity from the live Open Dental database:
// practice title/phone/address (preference table), operatories, providers
// (with NPI from NationalProvID) and staff (employee table).
// One-time data fix: older saved call scripts / after-hours text hardcoded the
// demo practice name ("Brightview Dental"). Replace it with the {{practice_name}}
// token so every script follows the synced practice identity.
const BRIGHTVIEW = /Brightview( Dental| Medical)?/g
async function migrateScriptsToToken(uid) {
  const result = { scriptHits: 0, afterHoursHits: 0 }
  const scriptsRef = adminDb.doc(`users/${uid}/private/call-scripts`)
  const snap1 = await scriptsRef.get().catch(() => null)
  if (snap1?.exists) {
    const json = JSON.stringify(snap1.data()?.scripts || {})
    if (json.includes('Brightview')) {
      result.scriptHits = (json.match(/Brightview/g) || []).length
      await scriptsRef.set({ scripts: JSON.parse(json.replace(BRIGHTVIEW, '{{practice_name}}')), updatedAt: new Date() }, { merge: true })
    }
  }
  const afterRef = adminDb.doc(`users/${uid}/private/after-hours`)
  const snap2 = await afterRef.get().catch(() => null)
  if (snap2?.exists) {
    const data = snap2.data()
    const json = JSON.stringify(data)
    if (json.includes('Brightview')) {
      result.afterHoursHits = (json.match(/Brightview/g) || []).length
      await afterRef.set(JSON.parse(json.replace(BRIGHTVIEW, '{{practice_name}}')))
    }
  }
  return result
}

export async function syncPracticeFromOpenDental(uid) {
  const opened = await openDentalConnection(uid)
  if (opened.error) return opened
  const { conn, systemName } = opened
  try {
    const [prefRows, opRows, defRows, provRows, empRows] = await Promise.all([
      conn.query("SELECT PrefName, ValueString FROM preference WHERE PrefName IN ('PracticeTitle','PracticeAddress','PracticeAddress2','PracticeCity','PracticeST','PracticeZip','PracticePhone')"),
      conn.query('SELECT OperatoryNum, OpName, Abbrev, IsHygiene FROM operatory WHERE IsHidden=0 ORDER BY ItemOrder'),
      conn.query('SELECT DefNum, ItemValue FROM definition WHERE Category=26'),
      conn.query("SELECT ProvNum, Abbr, LName, FName, PreferredName, NationalProvID, Specialty, ProvStatus FROM provider WHERE IsHidden=0 AND IsNotPerson=0 ORDER BY ItemOrder"),
      conn.query('SELECT EmployeeNum, FName, LName, PhoneExt, EmailWork FROM employee WHERE IsHidden=0 ORDER BY EmployeeNum'),
    ])

    const prefs = Object.fromEntries(prefRows[0].map((r) => [r.PrefName, r.ValueString || '']))
    const specialties = Object.fromEntries(defRows[0].map((r) => [Number(r.DefNum), String(r.ItemValue || '')]))

    const operatories = opRows[0].map((o) => ({
      id: Number(o.OperatoryNum),
      name: String(o.OpName || '').trim(),
      abbrev: String(o.Abbrev || '').trim(),
      hygiene: Boolean(o.IsHygiene),
    }))

    const doctors = provRows[0].map((d) => {
      const name = String(d.PreferredName || '').trim() || `${String(d.FName || '').trim()} ${String(d.LName || '').trim()}`.trim()
      const specialty = specialties[Number(d.Specialty)] || ''
      const isHygiene = /hygien/i.test(specialty)
      return {
        id: Number(d.ProvNum),
        name,
        display: isHygiene ? name : `Dr. ${name}`,
        abbrev: String(d.Abbr || '').trim(),
        npi: digits(d.NationalProvID).slice(0, 15),
        specialty,
      }
    })

    const staff = empRows[0].map((e) => ({
      id: Number(e.EmployeeNum),
      name: `${String(e.FName || '').trim()} ${String(e.LName || '').trim()}`.trim(),
      phoneExt: String(e.PhoneExt || '').replace(/\D/g, ''),
      email: String(e.EmailWork || '').trim(),
    }))

    const settings = normalize({
      source: 'opendental',
      syncedAt: new Date(),
      practice: {
        name: prefs.PracticeTitle || '',
        phone: prefs.PracticePhone || '',
        address1: prefs.PracticeAddress || '',
        address2: prefs.PracticeAddress2 || '',
        city: prefs.PracticeCity || '',
        state: prefs.PracticeST || '',
        zip: prefs.PracticeZip || '',
      },
      operatories,
      doctors,
      staff,
    })
    await practiceDoc(uid).set(settings)
    let migrated = null
    try {
      migrated = await migrateScriptsToToken(uid)
    } catch {}
    return { ok: true, settings, counts: { operatories: operatories.length, doctors: doctors.length, staff: staff.length }, migrated, source: systemName }
  } catch (e) {
    return { error: dbError(e), status: 502 }
  } finally {
    await conn.end().catch(() => {})
  }
}
