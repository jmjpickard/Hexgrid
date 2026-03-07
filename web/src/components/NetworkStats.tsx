'use client'

import { useEffect, useState, useCallback } from 'react'
import { fetchStats, type AccountStats } from '@/lib/api'

export default function NetworkStats() {
  const [stats, setStats] = useState<AccountStats | null>(null)

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
      <span>{stats.active_sessions} sessions</span>
      <span className="text-slate-700">/</span>
      <span>{stats.total_knowledge} knowledge</span>
      <span className="text-slate-700">/</span>
      <span>{stats.total_messages} messages</span>
      <span className="text-slate-700">/</span>
      <span>{stats.total_connections} connections</span>
    </div>
  )
}
