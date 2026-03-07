'use client'

import { useEffect, useState, useCallback } from 'react'
import { fetchKnowledge, type KnowledgeEntry } from '@/lib/api'

function relativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export default function KnowledgeExplorer() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [filter, setFilter] = useState('')

  const refresh = useCallback(async () => {
    const data = await fetchKnowledge()
    setEntries(data)
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  const filtered = filter
    ? entries.filter(e =>
        e.topic.toLowerCase().includes(filter.toLowerCase()) ||
        e.content.toLowerCase().includes(filter.toLowerCase()) ||
        e.tags.some(t => t.includes(filter.toLowerCase()))
      )
    : entries

  return (
    <div className="border border-white/[0.06]">
      <div className="px-4 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Knowledge</div>
        <span className="text-[10px] font-mono text-slate-600">{entries.length} entries</span>
      </div>
      <div className="px-4 py-2 border-b border-white/[0.04]">
        <input
          type="text"
          placeholder="search topics, content, tags..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="w-full text-xs font-mono bg-transparent text-slate-300 placeholder:text-slate-700 outline-none"
        />
      </div>
      <div className="max-h-96 overflow-y-auto divide-y divide-white/[0.03]">
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-xs font-mono text-slate-700">
            {entries.length === 0 ? 'No knowledge yet' : 'No matches'}
          </div>
        )}
        {filtered.map(entry => (
          <div key={entry.id} className="px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-slate-300">{entry.topic}</span>
              <span className="text-[10px] font-mono text-slate-700">{relativeTime(entry.created_at)}</span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed mb-2 line-clamp-3">{entry.content}</p>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-slate-600">{entry.session_name}</span>
              {entry.tags.map(tag => (
                <span
                  key={tag}
                  className="text-[10px] font-mono text-slate-500 bg-white/[0.04] px-1.5 py-0.5 cursor-pointer hover:text-slate-400"
                  onClick={() => setFilter(tag)}
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
