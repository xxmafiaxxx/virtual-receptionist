import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

const { FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS } = process.env

function credential() {
  if (FIREBASE_ADMIN_PROJECT_ID && FIREBASE_ADMIN_CLIENT_EMAIL && FIREBASE_ADMIN_PRIVATE_KEY) {
    return cert({
      projectId: FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, '\n'),
    })
  }
  // ponytail: only fall back to ADC when it can actually resolve (GCP runtime sets this),
  // otherwise stay unconfigured instead of throwing at import like the old code did.
  if (GOOGLE_APPLICATION_CREDENTIALS) return applicationDefault()
  return null
}

const cred = credential()
export const adminConfigured = cred !== null
const adminApp = adminConfigured ? (getApps()[0] || initializeApp({ credential: cred })) : null

export const adminAuth = adminApp ? getAuth(adminApp) : null
export const adminDb = adminApp ? getFirestore(adminApp) : null
