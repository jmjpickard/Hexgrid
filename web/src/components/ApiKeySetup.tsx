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

  const claudeCommand = `claude mcp add --scope project --transport http hexgrid ${mcpUrl} --header "Authorization: Bearer ${token}"`

  const codexConfig = `[mcp_servers.hexgrid]
url = "${mcpUrl}"
bearer_token_env_var = "HEXGRID_API_KEY"`

  const claudePrompt = `You are the live agent for this repository and should join HexGrid as this repo session.

Run these steps now:
1. Ensure HexGrid MCP is configured in project scope:
   ${claudeCommand}
2. Detect repo metadata:
   - repo_name: basename of git root
   - repo_url: git remote origin URL (fallback local://<absolute-path>)
   - repo_type: backend, frontend, or fullstack
   - tools: available CLI tools (git, rg, npm, pnpm, bun, docker, pytest, etc.)
3. Call connect_session once with:
   - name: "<repo_name>-claude"
   - repo_url
   - description: "Claude session for <repo_name> (<repo_type>)"
   - capabilities: include tags like "repo:<repo_name>", "surface:<repo_type>", and "tool:<tool>"
4. Save session_id from the response and call heartbeat every 5 minutes.
5. On shutdown, call disconnect with session_id.

Return a short summary with repo_name, repo_url, repo_type, capabilities, and session_id.`

  const codexPrompt = `You are the live Codex agent for this repository and should join HexGrid as this repo session.

Run these steps now:
1. Ensure project-scoped Codex MCP config exists at .codex/config.toml with:
   ${codexConfig}
2. Ensure bearer token is set for this shell:
   export HEXGRID_API_KEY="${token}"
3. If HexGrid tools are not available yet, restart Codex in this repo and continue.
4. Detect repo metadata:
   - repo_name: basename of git root
   - repo_url: git remote origin URL (fallback local://<absolute-path>)
   - repo_type: backend, frontend, or fullstack
   - tools: available CLI tools (git, rg, npm, pnpm, bun, docker, pytest, etc.)
5. Call connect_session once with:
   - name: "<repo_name>-codex"
   - repo_url
   - description: "Codex session for <repo_name> (<repo_type>)"
   - capabilities: include tags like "repo:<repo_name>", "surface:<repo_type>", and "tool:<tool>"
6. Save session_id and call heartbeat every 5 minutes.
7. On shutdown, call disconnect with session_id.

Return a short summary with repo_name, repo_url, repo_type, capabilities, and session_id.`

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
{config}
        </pre>
        <button
          onClick={() => copyText(config, 'config')}
          className="mt-2 w-full text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-2 transition-colors"
        >
          {copied === 'config' ? 'copied' : 'copy config'}
        </button>
      </div>

      <div>
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">Agent Bootstrap Prompts</div>
        <p className="text-xs text-slate-600 leading-relaxed mb-3">
          Paste one of these into a local Claude or Codex session running inside a repo to set up MCP and join HexGrid with repo metadata.
        </p>

        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">Claude</div>
        <pre className="text-xs font-mono text-slate-400 bg-white/[0.02] p-3 overflow-auto whitespace-pre-wrap border border-white/[0.04] max-h-56">
{claudePrompt}
        </pre>
        <button
          onClick={() => copyText(claudePrompt, 'claude')}
          className="mt-2 w-full text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-2 transition-colors"
        >
          {copied === 'claude' ? 'copied' : 'copy claude prompt'}
        </button>

        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mt-4 mb-2">Codex</div>
        <pre className="text-xs font-mono text-slate-400 bg-white/[0.02] p-3 overflow-auto whitespace-pre-wrap border border-white/[0.04] max-h-56">
{codexPrompt}
        </pre>
        <button
          onClick={() => copyText(codexPrompt, 'codex')}
          className="mt-2 w-full text-xs font-mono font-medium text-slate-900 bg-slate-300 hover:bg-white py-2 transition-colors"
        >
          {copied === 'codex' ? 'copied' : 'copy codex prompt'}
        </button>
      </div>
    </div>
  )
}
