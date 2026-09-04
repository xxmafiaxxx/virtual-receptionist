'use client'

import { useEffect, useState } from 'react'
import { GoogleAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { firebaseApp, firebaseConfigured } from '../../firebase'
import { ShieldCheck, Stethoscope } from 'lucide-react'

export default function AuthGate({ children, allowedEmails = [], allowedDomain = '' }) {
  const [user, setUser] = useState(undefined)
  const [error, setError] = useState('')
  const auth = firebaseApp ? getAuth(firebaseApp) : null

  const isAllowed = (candidate) => {
    if (!candidate?.email) return false
    if (!allowedEmails.length && !allowedDomain) return true
    return allowedEmails.includes(candidate.email.toLowerCase()) ||
      (allowedDomain && candidate.email.toLowerCase().endsWith(`@${allowedDomain}`))
  }

  useEffect(() => {
    if (!auth) { setUser(null); return }
    return onAuthStateChanged(auth, async (candidate) => {
      if (candidate && !isAllowed(candidate)) {
        await signOut(auth)
        setError('This Google account is not authorized for practice administration.')
        setUser(null)
      } else setUser(candidate)
    })
  }, [auth])

  const login = async () => {
    setError('')
    try { await signInWithPopup(auth, new GoogleAuthProvider()) }
    catch (err) { setError(err?.message || 'Google sign-in could not be completed.') }
  }

  if (user === undefined) return <div className="grid min-h-screen place-items-center bg-[#edf3f3] text-sm">Checking secure access…</div>
  if (!user) return <main className="mesh grid min-h-screen place-items-center p-5"><section className="panel w-full max-w-md rounded-[28px] p-7 text-center"><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[#143f49] text-white"><Stethoscope/></span><h1 className="display mt-5 text-3xl">Corinne Admin</h1><p className="mt-2 text-xs leading-6 text-[#657d82]">Sign in with an authorized Google account to access patients, appointments, and practice settings.</p>{!firebaseConfigured&&<p className="mt-4 rounded-xl bg-amber-100 p-3 text-[10px] text-amber-800">Firebase is not configured in the environment.</p>}{error&&<p className="mt-4 rounded-xl bg-red-50 p-3 text-[10px] text-red-700">{error}</p>}<button disabled={!auth} onClick={login} className="mt-6 flex w-full items-center justify-center gap-3 rounded-xl bg-[#147a76] py-3 text-xs font-bold text-white disabled:opacity-40"><ShieldCheck size={16}/>Continue with Google</button></section></main>
  return <>{children}<button onClick={()=>signOut(auth)} className="fixed bottom-5 right-5 z-50 rounded-xl border border-[#cad8da] bg-white px-3 py-2 text-[9px] font-bold shadow-lg">Sign out · {user.email}</button></>
}

