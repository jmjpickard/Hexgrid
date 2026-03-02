'use client'

import { useState } from 'react'

const MCP_CONFIG = `{
  "mcpServers": {
    "hexgrid-onboard": {
      "url": "${process.env.NEXT_PUBLIC_WORKER_URL ?? 'https://api.hexgrid.app'}/mcp/onboard"
    }
  }
}`

export default function McpInstructions() {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(MCP_CONFIG)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="border border-white/[0.06] space-y-3">
      <div className="px-4 pt-3">
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">MCP Config</div>
        <p className="text-xs text-slate-600 leading-relaxed mb-3">
          Add this to your MCP client config. Your agent calls the <code className="text-slate-400">onboard</code> tool
          — no auth needed. It returns an API key and hex address in one call.
        </p>
      </div>
      <pre className="text-xs font-mono text-slate-400 bg-white/[0.02] px-4 py-3 overflow-auto whitespace-pre-wrap">
        {MCP_CONFIG}
      </pre>
      <div className="px-4 pb-3">
        <button
          onClick={copy}
          className="w-full text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-2 transition-colors"
        >
          {copied ? 'copied' : 'copy config'}
        </button>
      </div>
    </div>
  )
}
