import { NextResponse } from 'next/server'
import { adminAuth, adminDb } from '../../../../lib/firebase-admin'

export const runtime = 'nodejs'

async function userFrom(request) {
  const v = request.headers.get('authorization') || ''
  if (!v.startsWith('Bearer ')) throw new Error('Unauthorized')
  return adminAuth.verifyIdToken(v.slice(7), true)
}
const authFail = (e) => e?.message === 'Unauthorized' || String(e?.code || '').startsWith('auth/')

const PRACTICE_ID = process.env.PRACTICE_ID || 'default'
const sharedDoc = () => adminDb.doc(`practices/${PRACTICE_ID}`)

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max)
const phoneDigits = (v) => String(v ?? '').replace(/\D/g, '')

function cleanPayers(raw) {
  if (!Array.isArray(raw)) throw new Error('payers must be an array.')
  if (raw.length > 200) throw new Error('Too many payers (max 200).')
  return raw.map((p, i) => {
    const name = str(p?.name, 120)
    if (!name) throw new Error(`Payer ${i + 1} is missing a name.`)
    const type = str(p?.type, 60) || 'Dental'
    const first = str(p?.first, 4000)
    const prompt = str(p?.prompt, 8000)
    const phone = str(p?.phone, 30)
    const electId = str(p?.electId, 30)
    const plansRaw = Array.isArray(p?.plans) ? p.plans.slice(0, 100) : []
    const plans = plansRaw.map((pl) => ({
      planNum: str(pl?.planNum, 30),
      groupNum: str(pl?.groupNum, 60),
      groupName: str(pl?.groupName, 120),
      employerName: str(pl?.employerName, 120),
      employerPhone: str(pl?.employerPhone, 30),
    }))
    return { name, type, first, prompt, phone, electId, plans }
  })
}

export async function POST(request) {
  try {
    const user = await userFrom(request)
    const body = await request.json().catch(() => ({}))
    const payers = cleanPayers(body.payers ?? body)
    await sharedDoc().set(
      { payers, updatedAt: new Date(), ownerUid: user.uid, pulledAt: new Date() },
      { merge: true },
    )
    return NextResponse.json({ ok: true, count: payers.length })
  } catch (e) {
    if (authFail(e)) return NextResponse.json({ error: 'Your session expired. Sign in again.' }, { status: 401 })
    const msg = String(e?.message || 'Could not save payers.')
    const code = /missing a name|must be an array|Too many/i.test(msg) ? 400 : 500
    return NextResponse.json({ error: msg }, { status: code })
  }
}
