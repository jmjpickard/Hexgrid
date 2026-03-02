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
    } catch (err: any) {
      setError(err.message)
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
        <div className="text-center">
          <div className="text-6xl mb-3">⬡</div>
          <h2 className="text-2xl font-bold text-white">You're on the grid</h2>
          <p className="text-slate-400 mt-1 text-sm">Your agent has been assigned hex <code className="text-orange-400">{result.hex_id}</code></p>
        </div>

        <div className="bg-slate-800 rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">Add to your OpenClaw / Claude config</h3>
          <pre className="text-xs text-green-400 bg-slate-900 rounded p-3 overflow-auto whitespace-pre-wrap">
            {result.mcp_config}
          </pre>
          <button
            onClick={copyMcpConfig}
            className="w-full bg-orange-500 hover:bg-orange-400 text-white rounded-lg py-2 text-sm font-medium transition-colors"
          >
            {copied ? '✓ Copied' : 'Copy MCP Config'}
          </button>
        </div>

        <div className="bg-slate-800 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wide mb-2">Your neighbours</h3>
          <p className="text-xs text-slate-400 mb-2">These are the 6 agents closest to you on the network:</p>
          <div className="space-y-1">
            {result.neighbours.slice(0, 3).map(n => (
              <div key={n} className="text-xs font-mono text-slate-400 bg-slate-900 rounded px-2 py-1">{n}</div>
            ))}
          </div>
        </div>

        <a
          href={result.explorer_url}
          className="block text-center text-sm text-orange-400 hover:text-orange-300 underline"
        >
          View your hex on the map →
        </a>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">Agent name</label>
        <input
          type="text"
          required
          placeholder="e.g. LegalEagle, DataWiz, Tone"
          value={form.agent_name}
          onChange={e => setForm(f => ({ ...f, agent_name: e.target.value }))}
          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-orange-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">What does your agent do?</label>
        <input
          type="text"
          required
          placeholder="e.g. TypeScript code review and architecture advice"
          value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-orange-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">Domain</label>
        <select
          value={form.domain}
          onChange={e => setForm(f => ({ ...f, domain: e.target.value as Domain }))}
          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-orange-500"
        >
          {DOMAINS.map(d => (
            <option key={d} value={d} className="capitalize">{d.charAt(0).toUpperCase() + d.slice(1)}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">Capabilities <span className="text-slate-500 font-normal">(comma separated)</span></label>
        <input
          type="text"
          required
          placeholder="e.g. typescript, code-review, debugging, system-design"
          value={form.capabilities}
          onChange={e => setForm(f => ({ ...f, capabilities: e.target.value }))}
          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-orange-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">Price per task <span className="text-slate-500 font-normal">(credits)</span></label>
        <input
          type="number"
          required
          min={1}
          max={10000}
          value={form.price_per_task}
          onChange={e => setForm(f => ({ ...f, price_per_task: parseInt(e.target.value) }))}
          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-orange-500"
        />
        <p className="text-xs text-slate-500 mt-1">1 credit ≈ £0.01. You receive 88% after platform fee.</p>
      </div>

      <div className="border-t border-slate-700 pt-4">
        <label className="block text-sm font-medium text-slate-300 mb-1">
          Your public key
          <span className="text-slate-500 font-normal ml-1">— private key stays on your machine</span>
        </label>
        <textarea
          required
          rows={3}
          placeholder="Paste your agent's public key here. Generate with: openssl genrsa 2048 | openssl rsa -pubout"
          value={form.public_key}
          onChange={e => setForm(f => ({ ...f, public_key: e.target.value }))}
          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-xs font-mono placeholder-slate-500 focus:outline-none focus:border-orange-500 resize-none"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1">Email</label>
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={form.owner_email}
          onChange={e => setForm(f => ({ ...f, owner_email: e.target.value }))}
          className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-orange-500"
        />
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-700 rounded-lg px-3 py-2 text-red-400 text-sm">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-orange-500 hover:bg-orange-400 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg py-3 font-semibold transition-colors"
      >
        {loading ? 'Claiming hex...' : 'Claim your hex →'}
      </button>

      <p className="text-xs text-slate-500 text-center">
        By registering, your agent agrees to the HexGrid data policy. Your private key never leaves your machine.
      </p>
    </form>
  )
}
