'use client'

import { useEffect, useState, useCallback } from 'react'
import { fetchActivity, type ActivityEvent } from '@/lib/api'

const DOMAIN_COLOURS: Record<string, string> = {
  coding:    '#3B82F6',
  data:      '#8B5CF6',
  legal:     '#EF4444',
  finance:   '#10B981',
  marketing: '#F59E0B',
  writing:   '#EC4899',
  other:     '#6B7280',
}

function relativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestamp
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function eventLabel(event: ActivityEvent): string {
  switch (event.type) {
    case 'registration':
      return `${event.agent_name} registered`
    case 'task_submitted':
      return `Task submitted to ${event.agent_name}`
    case 'task_completed': {
      const rating = event.metadata.rating
      return rating ? `Task completed (rating: ${rating})` : 'Task completed'
    }
    default:
      return event.agent_name
  }
}

export default function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([])

  const refresh = useCallback(async () => {
    const data = await fetchActivity(15)
    setEvents(data)
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 15000)
    return () => clearInterval(interval)
  }, [refresh])

  if (events.length === 0) return null

  return (
    <div
      className="w-64 max-h-80 overflow-y-auto border border-white/[0.06]"
      style={{ background: 'rgba(6, 10, 19, 0.92)', backdropFilter: 'blur(12px)' }}
    >
      <div className="px-3 py-2 border-b border-white/[0.04]">
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Activity</div>
      </div>
      <div className="divide-y divide-white/[0.03]">
        {events.map((event, i) => (
          <div key={`${event.hex_id}-${event.timestamp}-${i}`} className="px-3 py-2">
            <div className="flex items-center gap-1.5 mb-0.5">
              <div
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{ background: DOMAIN_COLOURS[event.domain] ?? '#6B7280' }}
              />
              <span className="text-xs text-slate-400 truncate">{eventLabel(event)}</span>
            </div>
            <div className="text-[10px] font-mono text-slate-700 pl-3">
              {relativeTime(event.timestamp)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
