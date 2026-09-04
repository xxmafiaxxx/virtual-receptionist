'use client'

import { useEffect } from 'react'
import { initializeFirebaseAnalytics } from '../firebase'

export default function FirebaseProvider({ children }) {
  useEffect(() => {
    initializeFirebaseAnalytics().catch((error) => {
      if (process.env.NODE_ENV === 'development') {
        console.warn('Firebase Analytics could not be initialized.', error)
      }
    })
  }, [])

  return children
}

