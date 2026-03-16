'use client'

import { useState } from 'react'
import { generateApiKey } from '@/lib/api'

interface ApiKeySetupProps {
  existingPrefix?: string | null
}

export default function ApiKeySetup({ existingPrefix }: ApiKeySetupProps) {
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [prefix, setPrefix] = useState<string | null>(existingPrefix ?? null)
  const [generating, setGenerating] = useState(false)
  const [copied, setCopied] = useState<'config' | 'claude' | 'codex' | null>(null)

  const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL ?? 'https://api.hexgrid.app'
  const mcpUrl = `${workerUrl}/mcp`
  const token = apiKey ?? 'YOUR_API_KEY'

  const config = JSON.stringify({
    mcpServers: {
      hexgrid: {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  }, null, 2)

  const cliInstall = 'npm install -g @jackpickard/hexgrid-cli'
  const codexQuickstart = `${cliInstall}
hexgrid login

# inside the repo you want to connect
hexgrid setup
hexgrid doctor --fix
hexgrid onboard
hexgrid run codex`

  const claudeQuickstart = `${cliInstall}
hexgrid login

# inside the repo you want to connect
hexgrid setup
hexgrid doctor --fix
hexgrid onboard
hexgrid run claude`

  async function generate() {
    setGenerating(true)
    const result = await generateApiKey()
    if (result) {
      setApiKey(result.key)
      setPrefix(result.key_prefix)
    }
    setGenerating(false)
  }

  function copyText(value: string, key: 'config' | 'claude' | 'codex') {
    navigator.clipboard.writeText(value)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="border border-white/[0.06] p-4 space-y-4">
      <div>
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">API Key</div>
        <p className="text-xs text-slate-600 leading-relaxed mb-3">
          Optional for manual MCP clients. The recommended Codex and Claude flow now uses the HexGrid CLI with{' '}
          <code className="text-slate-400">hexgrid login</code>.
        </p>
        {prefix && !apiKey && (
          <div className="text-xs font-mono text-slate-400 mb-2">
            Current key: <span className="text-slate-300">{prefix}...</span>
          </div>
        )}
        {apiKey && (
          <div className="bg-white/[0.03] p-3 mb-2 border border-white/[0.06]">
            <div className="text-[10px] font-mono text-amber-400 mb-1">Save this key — it won&apos;t be shown again</div>
            <div className="text-xs font-mono text-slate-300 break-all select-all">{apiKey}</div>
          </div>
        )}
        <button
          onClick={generate}
          disabled={generating}
          className="text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white px-4 py-2 transition-colors disabled:opacity-50"
        >
          {generating ? 'generating...' : prefix ? 'rotate key' : 'generate key'}
        </button>
      </div>

      <div>
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">Repo Quickstarts</div>
        <p className="text-xs text-slate-600 leading-relaxed mb-3">
          Install the CLI once, log in once per machine, then run one of these inside the repo you want to join.
          HexGrid handles repo setup, onboarding, connect, heartbeat, and disconnect for you.
        </p>
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">Codex</div>
        <pre className="text-xs font-mono text-slate-400 bg-white/[0.02] p-3 overflow-auto whitespace-pre-wrap border border-white/[0.04]">
{codexQuickstart}
        </pre>
        <button
          onClick={() => copyText(codexQuickstart, 'codex')}
          className="mt-2 w-full text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-2 transition-colors"
        >
          {copied === 'codex' ? 'copied' : 'copy codex quickstart'}
        </button>

        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mt-4 mb-2">Claude</div>
        <pre className="text-xs font-mono text-slate-400 bg-white/[0.02] p-3 overflow-auto whitespace-pre-wrap border border-white/[0.04] max-h-56">
{claudeQuickstart}
        </pre>
        <button
          onClick={() => copyText(claudeQuickstart, 'claude')}
          className="mt-2 w-full text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-2 transition-colors"
        >
          {copied === 'claude' ? 'copied' : 'copy claude quickstart'}
        </button>

        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mt-4 mb-2">Manual MCP Config</div>
        <p className="text-xs text-slate-600 leading-relaxed mb-3">
          Advanced fallback for custom MCP clients. Most users should use the CLI quickstart above instead of
          hand-editing config.
        </p>
        <pre className="text-xs font-mono text-slate-400 bg-white/[0.02] p-3 overflow-auto whitespace-pre-wrap border border-white/[0.04] max-h-56">
{config}
        </pre>
        <button
          onClick={() => copyText(config, 'config')}
          className="mt-2 w-full text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-2 transition-colors"
        >
          {copied === 'config' ? 'copied' : 'copy manual config'}
        </button>
      </div>
    </div>
  )
}
