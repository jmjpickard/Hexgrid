'use client'

import type { AgentSession } from '@/lib/api'

function relativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

interface SessionPanelProps {
  session: AgentSession
  onClose: () => void
}

export default function SessionPanel({ session, onClose }: SessionPanelProps) {
  const capabilities: string[] = (() => {
    try { return JSON.parse(session.capabilities) as string[] }
    catch { return [] }
  })()

  return (
    <div
      className="w-72 border border-white/[0.06] p-4"
      style={{ background: 'rgba(6, 10, 19, 0.92)', backdropFilter: 'blur(12px)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: session.status === 'active' ? '#10B981' : '#6B7280' }}
          />
          <span className="text-xs font-mono text-slate-500 uppercase">{session.status}</span>
        </div>
        <button
          onClick={onClose}
          className="text-slate-600 hover:text-slate-400 text-xs font-mono transition-colors"
        >
          close
        </button>
      </div>

      <h3 className="text-sm font-semibold text-slate-200 mb-1">{session.name}</h3>
      {session.description && (
        <p className="text-xs text-slate-500 leading-relaxed mb-3">{session.description}</p>
      )}

      {session.stack_count && session.stack_count > 1 && (
        <div className="border border-white/[0.04] p-2 mb-3">
          <div className="text-[10px] font-mono text-slate-600 uppercase tracking-wider mb-0.5">shared hex</div>
          <div className="text-xs font-mono text-slate-300">{session.stack_count} live sessions</div>
        </div>
      )}

      {session.repo_url && (
        <div className="border border-white/[0.04] p-2 mb-3">
          <div className="text-[10px] font-mono text-slate-600 uppercase tracking-wider mb-0.5">repo</div>
          <div className="text-xs font-mono text-slate-400 truncate">{session.repo_url}</div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="border border-white/[0.04] p-2">
          <div className="text-[10px] font-mono text-slate-600 uppercase tracking-wider mb-0.5">connected</div>
          <div className="text-xs font-mono text-slate-300">{relativeTime(session.connected_at)}</div>
        </div>
        <div className="border border-white/[0.04] p-2">
          <div className="text-[10px] font-mono text-slate-600 uppercase tracking-wider mb-0.5">heartbeat</div>
          <div className="text-xs font-mono text-slate-300">{relativeTime(session.last_heartbeat)}</div>
        </div>
      </div>

      {capabilities.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-mono text-slate-600 uppercase tracking-wider mb-1">capabilities</div>
          <div className="flex flex-wrap gap-1">
            {capabilities.map(cap => (
              <span key={cap} className="text-[10px] font-mono text-slate-400 bg-white/[0.04] px-1.5 py-0.5">
                {cap}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="text-[10px] font-mono text-slate-700 truncate">{session.hex_id}</div>
    </div>
  )
}
