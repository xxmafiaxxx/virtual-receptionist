import { NextResponse } from 'next/server'
import { adminDb } from '../../../../lib/firebase-admin'

export const runtime = 'nodejs'

// Public endpoint: no Firebase login. A practice is identified only by its kiosk token,
// and all data access runs through the Admin SDK here so the browser never touches Firestore.

const digits = (s) => String(s || '').replace(/\D/g, '')
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

function todayStr() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export async function POST(request) {
  try {
    const { token, name, phone } = await request.json().catch(() => ({}))
    if (!token || typeof token !== 'string' || token.length > 64) {
      return NextResponse.json({ error: 'This kiosk link is invalid.' }, { status: 400 })
    }
    const cleanName = norm(name)
    const cleanPhone = digits(phone)
    if (!cleanName || cleanName.length > 80 || cleanPhone.length < 7 || cleanPhone.length > 15) {
      return NextResponse.json({ error: 'Enter your full name and the phone number on file.' }, { status: 400 })
    }

    const linkSnap = await adminDb.doc(`kiosk-links/${token}`).get()
    const link = linkSnap.data()
    if (!link || !link.enabled) {
      return NextResponse.json({ error: 'This kiosk is not active. Please see the front desk.' }, { status: 403 })
    }

    const today = todayStr()
    const snap = await adminDb.collection(`users/${link.uid}/appointments`).where('date', '==', today).get()
    // Require BOTH phone and name to match, so a name alone can't confirm someone else's visit.
    const match = snap.docs.find((doc) => {
      const a = doc.data()
      return digits(a.phone) === cleanPhone && norm(a.patientName) === cleanName
    })

    if (!match) {
      return NextResponse.json({ found: false })
    }

    const a = match.data()
    const alreadyCheckedIn = a.status === 'checked-in'
    if (!alreadyCheckedIn) {
      await match.ref.update({ status: 'checked-in', checkedInAt: new Date() })
    }
    // Return only this patient's own appointment — never a list.
    return NextResponse.json({
      found: true,
      alreadyCheckedIn,
      appointment: { patientName: a.patientName || '', time: a.time || '', provider: a.provider || '' },
    })
  } catch (error) {
    return NextResponse.json({ error: 'Check-in could not be completed. Please see the front desk.' }, { status: 500 })
  }
}
