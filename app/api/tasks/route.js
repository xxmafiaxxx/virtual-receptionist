import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../lib/firebase-admin'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_BULK = 300

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
    title: a.title || '',
    patientName: a.patientName || '',
    phone: a.phone || '',
    dueDate: a.dueDate || '',
    notes: a.notes || '',
    status: a.status === 'done' ? 'done' : 'open',
    createdAt: a.createdAt?.toDate ? a.createdAt.toDate().toISOString() : null,
  }
}

function cleanTask(raw) {
  const title = String(raw?.title || '').trim()
  if (!title) return null
  const dueDate = String(raw?.dueDate || '').trim()
  return {
    title,
    patientName: String(raw?.patientName || '').trim(),
    phone: String(raw?.phone || '').replace(/[^+\d]/g, ''),
    dueDate: DATE_RE.test(dueDate) ? dueDate : '',
    notes: String(raw?.notes || '').trim(),
    status: 'open',
    createdAt: new Date(),
  }
}

export async function GET(request) {
  try {
    const user = await userFrom(request)
    const snap = await adminDb.collection(`users/${user.uid}/tasks`).orderBy('createdAt', 'desc').get()
    return NextResponse.json({ tasks: snap.docs.map(serialize) })
  } catch (error) {
    if (authFailure(error)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not load tasks.' }, { status: 500 })
  }
}

export async function POST(request) {
  try {
    const user = await userFrom(request)
    const body = await request.json()
    const list = Array.isArray(body?.tasks) ? body.tasks : [body]
    if (list.length > MAX_BULK) {
      return NextResponse.json({ error: `Import at most ${MAX_BULK} tasks at a time.` }, { status: 400 })
    }
    const tasks = list.map(cleanTask).filter(Boolean)
    if (!tasks.length) {
      return NextResponse.json({ error: 'A task description is required.' }, { status: 400 })
    }
    const batch = adminDb.batch()
    const ref = adminDb.collection(`users/${user.uid}/tasks`)
    const ids = tasks.map((task) => {
      const doc = ref.doc()
      batch.set(doc, task)
      return doc.id
    })
    await batch.commit()
    return NextResponse.json({ count: tasks.length, ids })
  } catch (error) {
    if (authFailure(error)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not save the tasks.' }, { status: 500 })
  }
}

export async function PATCH(request) {
  try {
    const user = await userFrom(request)
    const body = await request.json()
    const id = String(body?.id || '')
    const status = body?.status === 'done' ? 'done' : 'open'
    if (!id) return NextResponse.json({ error: 'Task id is required.' }, { status: 400 })
    await adminDb.doc(`users/${user.uid}/tasks/${id}`).update({ status })
    return NextResponse.json({ success: true })
  } catch (error) {
    if (authFailure(error)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not update the task.' }, { status: 500 })
  }
}

export async function DELETE(request) {
  try {
    const user = await userFrom(request)
    const id = new URL(request.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'Task id is required.' }, { status: 400 })
    await adminDb.doc(`users/${user.uid}/tasks/${id}`).delete()
    return NextResponse.json({ success: true })
  } catch (error) {
    if (authFailure(error)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    return NextResponse.json({ error: 'Could not delete the task.' }, { status: 500 })
  }
}
