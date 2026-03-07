'use client'

import { Suspense, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? 'https://api.hexgrid.app'

function normaliseUserCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}

function DeviceApprovalContent() {
  const searchParams = useSearchParams()
  const initialCode = useMemo(() => normaliseUserCode(searchParams.get('code') ?? ''), [searchParams])
  const [code, setCode] = useState(initialCode)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function approve(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    setMessage(null)

    try {
      const res = await fetch(`${WORKER_URL}/auth/device/approve`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: code }),
      })

      const data = await res.json() as { error?: string }
      if (!res.ok) {
        if (res.status === 401) {
          setError('Sign in first, then retry approval.')
        } else {
          setError(data.error ?? 'Failed to approve device code')
        }
      } else {
        setMessage('Device approved. Return to your terminal.')
      }
    } catch {
      setError('Approval request failed')
    }

    setSubmitting(false)
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6" style={{ background: '#060a13' }}>
      <div className="w-full max-w-md border border-white/[0.06] p-6 bg-black/20">
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">HexGrid CLI Login</div>
        <h1 className="text-slate-200 text-lg font-semibold mb-2">Approve device</h1>
        <p className="text-xs text-slate-500 leading-relaxed mb-5">
          Paste the code from your terminal and approve this device for your HexGrid account.
        </p>

        <form onSubmit={approve} className="space-y-3">
          <input
            type="text"
            placeholder="AB12CD34"
            value={code}
            onChange={e => setCode(normaliseUserCode(e.target.value))}
            className="w-full text-center text-lg font-mono tracking-[0.2em] bg-white/[0.03] border border-white/[0.08] text-slate-300 placeholder:text-slate-700 px-4 py-3 outline-none focus:border-slate-500 transition-colors"
            required
          />
          <button
            type="submit"
            disabled={submitting || code.length < 6}
            className="w-full text-sm font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-3 transition-colors disabled:opacity-50"
          >
            {submitting ? 'approving...' : 'approve device'}
          </button>
        </form>

        {message && <p className="mt-3 text-xs font-mono text-emerald-400">{message}</p>}
        {error && <p className="mt-3 text-xs font-mono text-red-400">{error}</p>}
      </div>
    </main>
  )
}

export default function DeviceApprovalPage() {
  return (
    <Suspense fallback={null}>
      <DeviceApprovalContent />
    </Suspense>
  )
}
