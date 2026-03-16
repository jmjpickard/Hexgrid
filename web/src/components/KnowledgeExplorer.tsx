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

function repoLabel(repoKey: string): string {
  if (!repoKey) return 'account'
  const trimmed = repoKey.replace(/^local:\/\//, '')
  const parts = trimmed.split('/').filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join('/') : trimmed
}

function statusTone(status: KnowledgeEntry['status']): string {
  if (status === 'canonical') return 'text-emerald-300 bg-emerald-500/10'
  if (status === 'candidate') return 'text-amber-300 bg-amber-500/10'
  if (status === 'stale') return 'text-rose-300 bg-rose-500/10'
  return 'text-slate-400 bg-white/[0.05]'
}

export default function KnowledgeExplorer() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([])
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | KnowledgeEntry['status']>('all')
  const [kindFilter, setKindFilter] = useState('all')
  const [repoFilter, setRepoFilter] = useState('all')

  const refresh = useCallback(async () => {
    const data = await fetchKnowledge({ limit: 100 })
    setEntries(data)
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  const availableKinds = Array.from(new Set(entries.map(entry => entry.kind))).sort()
  const availableRepos = Array.from(new Set(entries.map(entry => entry.repo_key).filter(Boolean))).sort()

  const filtered = entries.filter(entry => {
    const matchesQuery = !query
      || entry.topic.toLowerCase().includes(query.toLowerCase())
      || entry.content.toLowerCase().includes(query.toLowerCase())
      || entry.tags.some(tag => tag.includes(query.toLowerCase()))
      || entry.repo_key.toLowerCase().includes(query.toLowerCase())

    const matchesStatus = statusFilter === 'all' || entry.status === statusFilter
    const matchesKind = kindFilter === 'all' || entry.kind === kindFilter
    const matchesRepo = repoFilter === 'all' || entry.repo_key === repoFilter

    return matchesQuery && matchesStatus && matchesKind && matchesRepo
  })

  return (
    <div className="border border-white/[0.06]">
      <div className="px-4 py-3 border-b border-white/[0.04] flex items-center justify-between">
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Knowledge</div>
        <span className="text-[10px] font-mono text-slate-600">{entries.length} entries</span>
      </div>
      <div className="px-4 py-2 border-b border-white/[0.04] space-y-2">
        <input
          type="text"
          placeholder="search topics, content, tags..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="w-full text-xs font-mono bg-transparent text-slate-300 placeholder:text-slate-700 outline-none"
        />
        <div className="grid sm:grid-cols-3 gap-2">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as 'all' | KnowledgeEntry['status'])}
            className="text-[11px] font-mono bg-white/[0.03] text-slate-300 border border-white/[0.06] px-2 py-1.5 outline-none"
          >
            <option value="all">all status</option>
            <option value="canonical">canonical</option>
            <option value="candidate">candidate</option>
            <option value="stale">stale</option>
            <option value="archived">archived</option>
          </select>
          <select
            value={kindFilter}
            onChange={e => setKindFilter(e.target.value)}
            className="text-[11px] font-mono bg-white/[0.03] text-slate-300 border border-white/[0.06] px-2 py-1.5 outline-none"
          >
            <option value="all">all kinds</option>
            {availableKinds.map(kind => (
              <option key={kind} value={kind}>{kind}</option>
            ))}
          </select>
          <select
            value={repoFilter}
            onChange={e => setRepoFilter(e.target.value)}
            className="text-[11px] font-mono bg-white/[0.03] text-slate-300 border border-white/[0.06] px-2 py-1.5 outline-none"
          >
            <option value="all">all repos</option>
            {availableRepos.map(repo => (
              <option key={repo} value={repo}>{repoLabel(repo)}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="max-h-[36rem] overflow-y-auto divide-y divide-white/[0.03]">
        {filtered.length === 0 && (
          <div className="px-4 py-6 text-center text-xs font-mono text-slate-700">
            {entries.length === 0 ? 'No knowledge yet' : 'No matches'}
          </div>
        )}
        {filtered.map(entry => (
          <div key={entry.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-slate-300">{entry.topic}</span>
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 ${statusTone(entry.status)}`}>{entry.status}</span>
                  <span className="text-[10px] font-mono text-slate-500 bg-white/[0.04] px-1.5 py-0.5">{entry.kind}</span>
                </div>
                <div className="text-[10px] font-mono text-slate-600 mt-1">
                  {repoLabel(entry.repo_key)} · {Math.round(entry.confidence * 100)}% confidence · {entry.freshness}
                </div>
              </div>
              <span className="text-[10px] font-mono text-slate-700 whitespace-nowrap">{relativeTime(entry.updated_at)}</span>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed mb-2 whitespace-pre-line">{entry.content}</p>
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <span className="text-[10px] font-mono text-slate-600">{entry.session_name}</span>
              {entry.capability && (
                <span className="text-[10px] font-mono text-slate-500 bg-white/[0.04] px-1.5 py-0.5">
                  {entry.capability}
                </span>
              )}
              {entry.tags.map(tag => (
                <span
                  key={tag}
                  className="text-[10px] font-mono text-slate-500 bg-white/[0.04] px-1.5 py-0.5 cursor-pointer hover:text-slate-400"
                  onClick={() => setQuery(tag)}
                >
                  {tag}
                </span>
              ))}
            </div>
            {entry.source_refs.length > 0 && (
              <div className="text-[10px] font-mono text-slate-600">
                sources: {entry.source_refs.slice(0, 3).map(ref => ref.path).join(', ')}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
