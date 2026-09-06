'use client'

import { useEffect, useState } from 'react'
import { GoogleAuthProvider, createUserWithEmailAndPassword, getAuth, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut } from 'firebase/auth'
import { firebaseApp, firebaseConfigured } from '../../firebase'
import { Lock, Mail, ShieldCheck, Stethoscope } from 'lucide-react'

const AUTH_ERRORS = {
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'No account found with this email.',
  'auth/email-already-in-use': 'An account with this email already exists — sign in instead.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/too-many-requests': 'Too many attempts — try again in a few minutes.',
  'auth/operation-not-allowed': 'Email/password sign-in is not enabled for this project.',
  'auth/network-request-failed': 'Network error — check your connection and retry.',
}

export default function AuthGate({ children, allowedEmails = [], allowedDomain = '' }) {
  const [user, setUser] = useState(undefined)
  const [error, setError] = useState('')
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
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
        setError('This account is not authorized for practice administration.')
        setUser(null)
      } else setUser(candidate)
    })
  }, [auth])

  const friendly = (err) => AUTH_ERRORS[err?.code] || err?.message || 'Sign-in could not be completed.'

  const loginGoogle = async () => {
    setError('')
    try { await signInWithPopup(auth, new GoogleAuthProvider()) }
    catch (err) { setError(friendly(err)) }
  }

  const submitEmail = async (event) => {
    event.preventDefault()
    if (!auth || busy) return
    setBusy(true)
    setError('')
    try {
      if (mode === 'signup') await createUserWithEmailAndPassword(auth, email.trim(), password)
      else await signInWithEmailAndPassword(auth, email.trim(), password)
    } catch (err) { setError(friendly(err)) }
    finally { setBusy(false) }
  }

  if (user === undefined) return <div className="grid min-h-screen place-items-center bg-[#edf3f3] text-sm">Checking secure access…</div>

  if (!user) return (
    <main className="mesh grid min-h-screen place-items-center p-5">
      <section className="panel w-full max-w-md rounded-[28px] p-7 text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[#143f49] text-white"><Stethoscope/></span>
        <h1 className="display mt-5 text-3xl">Corinne Admin</h1>
        <p className="mt-2 text-xs leading-6 text-[#657d82]">Sign in with an authorized account to access patients, appointments, and practice settings.</p>
        {!firebaseConfigured && <p className="mt-4 rounded-xl bg-amber-100 p-3 text-[10px] text-amber-800">Firebase is not configured in the environment.</p>}
        {error && <p className="mt-4 rounded-xl bg-red-50 p-3 text-[10px] text-red-700">{error}</p>}
        <button disabled={!auth} onClick={loginGoogle} className="mt-6 flex w-full items-center justify-center gap-3 rounded-xl bg-[#147a76] py-3 text-xs font-bold text-white disabled:opacity-40"><ShieldCheck size={16}/>Continue with Google</button>
        <div className="mt-5 flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-[#9ab3b8]"><span className="h-px flex-1 bg-[#dbe7e9]"/>or<span className="h-px flex-1 bg-[#dbe7e9]"/></div>
        <form onSubmit={submitEmail} className="mt-5 space-y-3 text-left">
          <label className="flex items-center gap-2 rounded-xl border border-[#cad8da] bg-white px-3 py-2.5 focus-within:border-[#147a76]">
            <Mail size={15} className="shrink-0 text-[#9ab3b8]"/>
            <input type="email" required value={email} onChange={(e)=>setEmail(e.target.value)} placeholder="Email address" autoComplete="email" className="w-full bg-transparent text-xs text-[#143f49] outline-none placeholder:text-[#9ab3b8]"/>
          </label>
          <label className="flex items-center gap-2 rounded-xl border border-[#cad8da] bg-white px-3 py-2.5 focus-within:border-[#147a76]">
            <Lock size={15} className="shrink-0 text-[#9ab3b8]"/>
            <input type="password" required value={password} onChange={(e)=>setPassword(e.target.value)} placeholder="Password" autoComplete={mode==='signup'?'new-password':'current-password'} className="w-full bg-transparent text-xs text-[#143f49] outline-none placeholder:text-[#9ab3b8]"/>
          </label>
          <button type="submit" disabled={!auth || busy} className="flex w-full items-center justify-center gap-3 rounded-xl bg-[#143f49] py-3 text-xs font-bold text-white disabled:opacity-40">
            {mode==='signup' ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <button onClick={()=>{setMode(mode==='signup'?'signin':'signup'); setError('')}} className="mt-4 text-[10px] font-bold text-[#147a76] underline-offset-4 hover:underline">
          {mode==='signup' ? 'Already have an account? Sign in' : 'New here? Create an account with email and password'}
        </button>
      </section>
    </main>
  )

  return <>{children}<button onClick={()=>signOut(auth)} className="fixed bottom-5 right-5 z-50 rounded-xl border border-[#cad8da] bg-white px-3 py-2 text-[9px] font-bold shadow-lg">Sign out · {user.email}</button></>
}
