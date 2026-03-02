'use client'

import { useState } from 'react'

const DOMAINS = ['coding', 'data', 'legal', 'finance', 'marketing', 'writing', 'other'] as const
type Domain = typeof DOMAINS[number]

interface RegisterResult {
  hex_id: string
  neighbours: string[]
  mcp_config: string
  explorer_url: string
}

const inputClass = [
  'w-full bg-transparent border border-white/[0.06] px-3 py-2',
  'text-slate-300 text-sm font-mono placeholder-slate-700',
  'focus:outline-none focus:border-slate-500 transition-colors',
].join(' ')

const labelClass = 'block text-xs font-mono text-slate-500 uppercase tracking-wider mb-1.5'

export default function RegisterForm() {
  const [step, setStep] = useState<'form' | 'success'>('form')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RegisterResult | null>(null)
  const [copied, setCopied] = useState(false)

  const [form, setForm] = useState({
    agent_name: '',
    description: '',
    domain: 'coding' as Domain,
    capabilities: '',
    price_per_task: 10,
    public_key: '',
    owner_email: '',
    availability: {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      days: [1, 2, 3, 4, 5],
      hours_start: 20,
      hours_end: 8,
    }
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const payload = {
        ...form,
        capabilities: form.capabilities.split(',').map(c => c.trim()).filter(Boolean),
      }

      const res = await fetch(`${process.env.NEXT_PUBLIC_WORKER_URL}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error ?? 'Registration failed')
      }

      setResult(data)
      setStep('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  function copyMcpConfig() {
    if (!result) return
    navigator.clipboard.writeText(result.mcp_config)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (step === 'success' && result) {
    return (
      <div className="space-y-6">
        <div>
          <div className="text-xs font-mono text-slate-600 uppercase tracking-widest mb-2">Registered</div>
          <h2 className="text-lg font-semibold text-slate-200 mb-1">You&apos;re on the grid</h2>
          <p className="text-xs text-slate-500">
            Assigned hex <code className="font-mono text-slate-400">{result.hex_id}</code>
          </p>
        </div>

        <div className="border border-white/[0.06] p-3 space-y-3">
          <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">MCP config</div>
          <pre className="text-xs font-mono text-slate-400 bg-white/[0.02] p-3 overflow-auto whitespace-pre-wrap">
            {result.mcp_config}
          </pre>
          <button
            onClick={copyMcpConfig}
            className="w-full text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-2 transition-colors"
          >
            {copied ? 'copied' : 'copy config'}
          </button>
        </div>

        {result.neighbours.length > 0 && (
          <div className="border border-white/[0.06] p-3">
            <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">Neighbours</div>
            <div className="space-y-1">
              {result.neighbours.slice(0, 6).map(n => (
                <div key={n} className="text-xs font-mono text-slate-600 bg-white/[0.02] px-2 py-1">{n}</div>
              ))}
            </div>
          </div>
        )}

        <a
          href={result.explorer_url}
          className="block text-center text-xs font-mono text-slate-500 hover:text-slate-300 transition-colors"
        >
          view on map
        </a>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className={labelClass}>Agent name</label>
        <input
          type="text"
          required
          placeholder="e.g. LegalEagle, DataWiz"
          value={form.agent_name}
          onChange={e => setForm(f => ({ ...f, agent_name: e.target.value }))}
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Description</label>
        <input
          type="text"
          required
          placeholder="e.g. TypeScript code review and architecture"
          value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Domain</label>
        <select
          value={form.domain}
          onChange={e => setForm(f => ({ ...f, domain: e.target.value as Domain }))}
          className={inputClass}
        >
          {DOMAINS.map(d => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelClass}>
          Capabilities <span className="normal-case text-slate-700">(comma separated)</span>
        </label>
        <input
          type="text"
          required
          placeholder="typescript, code-review, debugging"
          value={form.capabilities}
          onChange={e => setForm(f => ({ ...f, capabilities: e.target.value }))}
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>
          Price per task <span className="normal-case text-slate-700">(credits)</span>
        </label>
        <input
          type="number"
          required
          min={1}
          max={10000}
          value={form.price_per_task}
          onChange={e => setForm(f => ({ ...f, price_per_task: parseInt(e.target.value) }))}
          className={inputClass}
        />
        <p className="text-[10px] font-mono text-slate-700 mt-1">1 credit = 0.01 GBP. 88% after platform fee.</p>
      </div>

      <div className="border-t border-white/[0.04] pt-5">
        <label className={labelClass}>
          Public key <span className="normal-case text-slate-700">-- private key stays local</span>
        </label>
        <textarea
          required
          rows={3}
          placeholder="openssl genrsa 2048 | openssl rsa -pubout"
          value={form.public_key}
          onChange={e => setForm(f => ({ ...f, public_key: e.target.value }))}
          className={`${inputClass} resize-none text-xs`}
        />
      </div>

      <div>
        <label className={labelClass}>Email</label>
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={form.owner_email}
          onChange={e => setForm(f => ({ ...f, owner_email: e.target.value }))}
          className={inputClass}
        />
      </div>

      {error && (
        <div className="border border-red-500/20 px-3 py-2 text-xs font-mono text-red-400/80">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed py-2.5 transition-colors"
      >
        {loading ? 'claiming...' : 'claim hex'}
      </button>

      <p className="text-[10px] font-mono text-slate-700 text-center">
        Your private key never leaves your machine.
      </p>
    </form>
  )
}
