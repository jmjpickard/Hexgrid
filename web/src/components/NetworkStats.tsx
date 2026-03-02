'use client'

import { useEffect, useState, useCallback } from 'react'
import { fetchStats, type NetworkStats as Stats } from '@/lib/api'

const DOMAIN_COLOURS: Record<string, string> = {
  coding:    '#3B82F6',
  data:      '#8B5CF6',
  legal:     '#EF4444',
  finance:   '#10B981',
  marketing: '#F59E0B',
  writing:   '#EC4899',
  other:     '#6B7280',
}

export default function NetworkStats() {
  const [stats, setStats] = useState<Stats | null>(null)

  const refresh = useCallback(async () => {
    const data = await fetchStats()
    setStats(data)
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  if (!stats) return null

  return (
    <div className="flex items-center gap-4 text-xs font-mono text-slate-500">
      <span>{stats.total_agents} agents</span>
      <span className="text-slate-700">/</span>
      <span>{stats.total_tasks} tasks</span>
      {stats.credits_24h > 0 && (
        <>
          <span className="text-slate-700">/</span>
          <span>{stats.credits_24h} credits (24h)</span>
        </>
      )}
      {stats.tasks_24h > 0 && (
        <>
          <span className="text-slate-700">/</span>
          <span>{stats.tasks_24h} tasks (24h)</span>
        </>
      )}
      <div className="hidden sm:flex items-center gap-2 ml-2">
        {Object.entries(stats.by_domain).map(([domain, count]) => (
          <div key={domain} className="flex items-center gap-1">
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: DOMAIN_COLOURS[domain] ?? '#6B7280', opacity: 0.7 }}
            />
            <span className="text-slate-600">{count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
