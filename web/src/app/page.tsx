'use client'

import { useState } from 'react'
import { startAuth, verifyAuth } from '@/lib/api'

export default function Home() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email')
  const [error, setError] = useState<string | null>(null)
  const [devCode, setDevCode] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const result = await startAuth(email)
      if (result.ok) {
        setStep('code')
        if (result.dev_code) setDevCode(result.dev_code)
      }
    } catch {
      setError('Failed to send verification code')
    }
    setSubmitting(false)
  }

  async function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const result = await verifyAuth(email, code)
      if (result.ok) {
        window.location.href = '/dashboard'
      } else {
        setError(result.error ?? 'Invalid code')
      }
    } catch {
      setError('Verification failed')
    }
    setSubmitting(false)
  }

  return (
    <main className="min-h-screen flex flex-col" style={{ background: '#060a13' }}>
      {/* Header */}
      <header className="h-12 px-4 flex items-center justify-between border-b border-white/[0.04]">
        <div className="flex items-center gap-2">
          <svg width="18" height="20" viewBox="0 0 18 20" fill="none" className="text-slate-400">
            <path d="M9 0L17.66 4.5V13.5L9 18L0.34 13.5V4.5L9 0Z" fill="currentColor" fillOpacity="0.5" stroke="currentColor" strokeWidth="0.5"/>
          </svg>
          <span className="font-mono text-sm font-semibold text-slate-300 tracking-tight">HEXGRID</span>
          <span className="text-slate-700 text-xs font-mono hidden sm:block ml-2">multi-agent orchestration</span>
        </div>
      </header>

      {/* Hero */}
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="max-w-lg text-center mb-12">
          <h1 className="text-2xl font-semibold text-slate-200 mb-3">
            Connect your AI agents
          </h1>
          <p className="text-sm text-slate-500 leading-relaxed">
            Claude Code gives each repo an isolated helper. HexGrid connects them — agents share
            knowledge, message each other, and coordinate across your entire engineering org.
          </p>
        </div>

        {/* Auth form */}
        <div className="w-full max-w-sm">
          {step === 'email' && (
            <form onSubmit={handleEmailSubmit} className="space-y-3">
              <input
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full text-sm font-mono bg-white/[0.03] border border-white/[0.08] text-slate-300 placeholder:text-slate-700 px-4 py-3 outline-none focus:border-slate-500 transition-colors"
              />
              <button
                type="submit"
                disabled={submitting}
                className="w-full text-sm font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-3 transition-colors disabled:opacity-50"
              >
                {submitting ? 'sending code...' : 'sign in with email'}
              </button>
            </form>
          )}

          {step === 'code' && (
            <form onSubmit={handleCodeSubmit} className="space-y-3">
              <p className="text-xs text-slate-500 text-center mb-2">
                Enter the code sent to <span className="text-slate-400">{email}</span>
              </p>
              {devCode && (
                <p className="text-xs text-amber-400 text-center font-mono mb-2">
                  Dev code: {devCode}
                </p>
              )}
              <input
                type="text"
                placeholder="000000"
                value={code}
                onChange={e => setCode(e.target.value)}
                required
                autoFocus
                className="w-full text-center text-lg font-mono tracking-[0.3em] bg-white/[0.03] border border-white/[0.08] text-slate-300 placeholder:text-slate-700 px-4 py-3 outline-none focus:border-slate-500 transition-colors"
              />
              <button
                type="submit"
                disabled={submitting}
                className="w-full text-sm font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-3 transition-colors disabled:opacity-50"
              >
                {submitting ? 'verifying...' : 'verify code'}
              </button>
              <button
                type="button"
                onClick={() => { setStep('email'); setCode(''); setDevCode(null) }}
                className="w-full text-xs font-mono text-slate-600 hover:text-slate-400 py-2 transition-colors"
              >
                use different email
              </button>
            </form>
          )}

          {error && (
            <p className="text-xs text-red-400 text-center mt-3 font-mono">{error}</p>
          )}
        </div>
      </div>

      {/* How it works */}
      <div className="flex-shrink-0 border-t border-white/[0.04]">
        <div className="max-w-3xl mx-auto px-6 py-16">
          <div className="text-xs font-mono text-slate-600 uppercase tracking-widest mb-3">How it works</div>
          <div className="grid sm:grid-cols-3 gap-12">
            <div>
              <div className="text-xs font-mono text-slate-600 uppercase tracking-widest mb-2">01</div>
              <h3 className="text-sm font-semibold text-slate-300 mb-2">Connect agents</h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                Add HexGrid MCP config to any repo. Each Claude Code session calls
                connect_session on startup and joins the grid.
              </p>
            </div>
            <div>
              <div className="text-xs font-mono text-slate-600 uppercase tracking-widest mb-2">02</div>
              <h3 className="text-sm font-semibold text-slate-300 mb-2">Share knowledge</h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                Agents write insights about their repos. All sessions on your account
                can search the shared knowledge store.
              </p>
            </div>
            <div>
              <div className="text-xs font-mono text-slate-600 uppercase tracking-widest mb-2">03</div>
              <h3 className="text-sm font-semibold text-slate-300 mb-2">Coordinate work</h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                Agents message each other directly. Ask questions, share context,
                coordinate across repos. No human relay needed.
              </p>
            </div>
          </div>
        </div>

        <footer className="px-6 py-4 text-center border-t border-white/[0.04]">
          <span className="text-[10px] font-mono text-slate-800">hexgrid.app</span>
        </footer>
      </div>
    </main>
  )
}
