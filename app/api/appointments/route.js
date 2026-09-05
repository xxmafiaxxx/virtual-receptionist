import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../lib/firebase-admin'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function userFrom(request) {
  const value = request.headers.get('authorization') || ''
  if (!value.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(value.slice(7), true)
}

function authFailure(error) {
  return error?.message === 'Unauthorized' || String(error?.code || '').startsWith('auth/')
}

function serialize(doc) {
  const a = doc.data()
  return {
    id: doc.id,
    patientName: a.patientName || '',
    phone: a.phone || '',
    date: a.date || '',
    time: a.time || '',
    provider: a.provider || '',
    operatory: a.operatory || '',
    status: a.status || 'scheduled',
    checkedInAt: a.checkedInAt?.toDate ? a.checkedInAt.toDate().toISOString() : null,
  }
}

export async function GET(request) {
  try {
    const user = await userFrom(request)
    const date = new URL(request.url).searchParams.get('date')
    let ref = adminDb.collection(`users/${user.uid}/appointments`)
    if (date && DATE_RE.test(date)) ref = ref.where('date', '==', date)
    const snap = await ref.get()
    const appointments = snap.docs.map(serialize)
    return NextResponse.json({ appointments })
  } catch (error) {
    if (authFailure(error)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not load appointments.' }, { status: 500 })
  }
}

export async function POST(request) {
  try {
    const user = await userFrom(request)
    const body = await request.json()
    const patientName = String(body.patientName || '').trim()
    const phone = String(body.phone || '').replace(/[^+\d]/g, '')
    const date = String(body.date || '').trim()
    const time = String(body.time || '').trim()
    const provider = String(body.provider || '').trim()
    const operatory = String(body.operatory || '').trim()
    if (!patientName || !phone || !DATE_RE.test(date) || !time) {
      return NextResponse.json({ error: 'Patient name, phone, a valid date, and a time are required.' }, { status: 400 })
    }
    const ref = await adminDb.collection(`users/${user.uid}/appointments`).add({
      patientName, phone, date, time, provider, operatory,
      status: 'scheduled', createdAt: new Date(),
    })
    return NextResponse.json({ id: ref.id })
  } catch (error) {
    if (authFailure(error)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not save the appointment.' }, { status: 500 })
  }
}

export async function DELETE(request) {
  try {
    const user = await userFrom(request)
    const id = new URL(request.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'Appointment id is required.' }, { status: 400 })
    await adminDb.doc(`users/${user.uid}/appointments/${id}`).delete()
    return NextResponse.json({ success: true })
  } catch (error) {
    if (authFailure(error)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not delete the appointment.' }, { status: 500 })
  }
}
