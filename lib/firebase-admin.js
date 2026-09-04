import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

function credentials() {
  const { FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, FIREBASE_ADMIN_PRIVATE_KEY } = process.env
  if (FIREBASE_ADMIN_PROJECT_ID && FIREBASE_ADMIN_CLIENT_EMAIL && FIREBASE_ADMIN_PRIVATE_KEY) {
    return cert({
      projectId: FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, '\n'),
    })
  }
  return applicationDefault()
}

const adminApp = getApps()[0] || initializeApp({ credential: credentials() })
export const adminAuth = getAuth(adminApp)
export const adminDb = getFirestore(adminApp)

