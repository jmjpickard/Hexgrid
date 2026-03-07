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
  const [copied, setCopied] = useState(false)

  async function generate() {
    setGenerating(true)
    const result = await generateApiKey()
    if (result) {
      setApiKey(result.key)
      setPrefix(result.key_prefix)
    }
    setGenerating(false)
  }

  function copyConfig() {
    const config = JSON.stringify({
      mcpServers: {
        hexgrid: {
          url: `${process.env.NEXT_PUBLIC_WORKER_URL ?? 'https://api.hexgrid.app'}/mcp`,
          headers: {
            Authorization: `Bearer ${apiKey ?? 'YOUR_API_KEY'}`,
          },
        },
      },
    }, null, 2)
    navigator.clipboard.writeText(config)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="border border-white/[0.06] p-4 space-y-4">
      <div>
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">API Key</div>
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
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">MCP Config</div>
        <p className="text-xs text-slate-600 leading-relaxed mb-3">
          Add this to your Claude Code MCP config (or any MCP client). Each agent session calls{' '}
          <code className="text-slate-400">connect_session</code> on startup.
        </p>
        <pre className="text-xs font-mono text-slate-400 bg-white/[0.02] p-3 overflow-auto whitespace-pre-wrap border border-white/[0.04]">
{JSON.stringify({
  mcpServers: {
    hexgrid: {
      url: `${process.env.NEXT_PUBLIC_WORKER_URL ?? 'https://api.hexgrid.app'}/mcp`,
      headers: {
        Authorization: `Bearer ${apiKey ?? 'YOUR_API_KEY'}`,
      },
    },
  },
}, null, 2)}
        </pre>
        <button
          onClick={copyConfig}
          className="mt-2 w-full text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-2 transition-colors"
        >
          {copied ? 'copied' : 'copy config'}
        </button>
      </div>
    </div>
  )
}
