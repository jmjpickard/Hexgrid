'use client'

import { useEffect, useState, useCallback } from 'react'
import { fetchMessages, type MessageEntry } from '@/lib/api'

function relativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

const STATUS_COLOURS: Record<string, string> = {
  pending: '#F59E0B',
  answered: '#10B981',
  expired: '#6B7280',
}

export default function MessageFeed() {
  const [messages, setMessages] = useState<MessageEntry[]>([])

  const refresh = useCallback(async () => {
    const data = await fetchMessages(30)
    setMessages(data)
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 15000)
    return () => clearInterval(interval)
  }, [refresh])

  return (
    <div className="border border-white/[0.06]">
      <div className="px-4 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Messages</div>
        <span className="text-[10px] font-mono text-slate-600">{messages.length} recent</span>
      </div>
      <div className="max-h-96 overflow-y-auto divide-y divide-white/[0.03]">
        {messages.length === 0 && (
          <div className="px-4 py-6 text-center text-xs font-mono text-slate-700">
            No messages yet
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className="px-4 py-3">
            <div className="flex items-center gap-2 mb-1">
              <div
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ background: STATUS_COLOURS[msg.status] ?? '#6B7280' }}
              />
              <span className="text-xs font-mono text-slate-400">
                {msg.from_session_name}
              </span>
              <span className="text-xs text-slate-700">&rarr;</span>
              <span className="text-xs font-mono text-slate-400">
                {msg.to_session_name}
              </span>
              <span className="text-[10px] font-mono text-slate-700 ml-auto">
                {relativeTime(msg.created_at)}
              </span>
            </div>
            <div className="text-xs text-slate-500 leading-relaxed mb-1 line-clamp-2">
              Q: {msg.question}
            </div>
            {msg.answer && (
              <div className="text-xs text-slate-400 leading-relaxed line-clamp-2">
                A: {msg.answer}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
