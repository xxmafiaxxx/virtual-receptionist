'use client'
import { useEffect, useRef, useState } from 'react'
import { Check, Phone, Stethoscope, UserRound } from 'lucide-react'

export default function KioskCheckIn({ token }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const timer = useRef(null)

  const reset = () => { setName(''); setPhone(''); setResult(null); setBusy(false) }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const submit = async (e) => {
    e?.preventDefault()
    if (!name.trim() || !phone.trim() || busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/kiosk/check-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name, phone }),
      })
      const data = await res.json()
      if (!res.ok) setResult({ type: 'error', message: data.error || 'Something went wrong. Please see the front desk.' })
      else if (data.found) setResult({ type: 'success', appt: data.appointment, already: data.alreadyCheckedIn })
      else setResult({ type: 'notfound' })
    } catch {
      setResult({ type: 'error', message: 'We could not reach the front desk system. Please see the receptionist.' })
    } finally {
      setBusy(false)
      timer.current = setTimeout(reset, 9000)
    }
  }

  return (
    <main className="mesh grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-xl">
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="grid size-16 place-items-center rounded-3xl bg-[#143f49] text-white"><Stethoscope size={30} /></span>
          <h1 className="display mt-4 text-4xl">Welcome to Brightview</h1>
          <p className="mt-2 text-base text-[#5c757a]">Please check in for your appointment below.</p>
        </div>

        {!result && (
          <form onSubmit={submit} className="panel rounded-[28px] p-7">
            <label className="block text-xs font-bold uppercase tracking-wider text-[#5c757a]">
              Your full name
              <div className="mt-2 flex items-center gap-3 rounded-2xl border border-[#cbdadb] bg-[#f9fbfb] px-4 focus-within:border-[#147a76]">
                <UserRound size={20} className="text-[#8aa0a4]" />
                <input
                  className="w-full bg-transparent py-4 text-lg outline-none"
                  value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe" autoComplete="off" autoFocus
                />
              </div>
            </label>
            <label className="mt-5 block text-xs font-bold uppercase tracking-wider text-[#5c757a]">
              Phone number on file
              <div className="mt-2 flex items-center gap-3 rounded-2xl border border-[#cbdadb] bg-[#f9fbfb] px-4 focus-within:border-[#147a76]">
                <Phone size={20} className="text-[#8aa0a4]" />
                <input
                  className="mono w-full bg-transparent py-4 text-lg outline-none"
                  value={phone} onChange={(e) => setPhone(e.target.value)}
                  placeholder="(555) 014-4821" inputMode="tel" autoComplete="off"
                />
              </div>
            </label>
            <button
              type="submit" disabled={busy || !name.trim() || !phone.trim()}
              className="mt-7 w-full rounded-2xl bg-[#147a76] py-5 text-lg font-bold text-white transition disabled:opacity-40"
            >
              {busy ? 'Checking you in…' : 'Check in'}
            </button>
          </form>
        )}

        {result?.type === 'success' && (
          <div className="panel rounded-[28px] p-9 text-center">
            <span className="mx-auto grid size-20 place-items-center rounded-full bg-[#d7f5dd] text-[#2f8a4f]"><Check size={40} /></span>
            <h2 className="display mt-5 text-4xl">You're all set{result.appt?.patientName ? `, ${result.appt.patientName.split(' ')[0]}` : ''}!</h2>
            <p className="mt-3 text-lg text-[#5c757a]">
              {result.already ? "You were already checked in. " : ''}
              Please have a seat{result.appt?.time ? ` — your ${result.appt.time}` : ''}
              {result.appt?.provider ? ` appointment with ${result.appt.provider}` : ' appointment'} is confirmed.
            </p>
            <p className="mt-6 text-sm text-[#8aa0a4]">A team member will call you shortly.</p>
          </div>
        )}

        {result?.type === 'notfound' && (
          <div className="panel rounded-[28px] p-9 text-center">
            <h2 className="display text-3xl">We couldn't find your appointment</h2>
            <p className="mt-3 text-lg text-[#5c757a]">Please double-check your name and phone number, or see the front desk for help.</p>
            <button onClick={reset} className="mt-7 rounded-2xl bg-[#147a76] px-8 py-4 text-base font-bold text-white">Try again</button>
          </div>
        )}

        {result?.type === 'error' && (
          <div className="panel rounded-[28px] p-9 text-center">
            <h2 className="display text-3xl">Something went wrong</h2>
            <p className="mt-3 text-lg text-[#5c757a]">{result.message}</p>
            <button onClick={reset} className="mt-7 rounded-2xl bg-[#147a76] px-8 py-4 text-base font-bold text-white">Try again</button>
          </div>
        )}
      </div>
    </main>
  )
}
