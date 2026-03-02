// HexGrid — API fetch helpers

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? ''

export interface ActivityEvent {
  type: 'registration' | 'task_submitted' | 'task_completed'
  agent_name: string
  domain: string
  hex_id: string
  timestamp: number
  metadata: Record<string, unknown>
}

export interface NetworkStats {
  total_agents: number
  total_tasks: number
  avg_reputation: number
  by_domain: Record<string, number>
  credits_24h: number
  tasks_24h: number
}

export async function fetchActivity(limit = 20): Promise<ActivityEvent[]> {
  const res = await fetch(`${WORKER_URL}/api/activity?limit=${limit}`)
  if (!res.ok) return []
  const data = await res.json() as { events: ActivityEvent[] }
  return data.events
}

export async function fetchStats(): Promise<NetworkStats | null> {
  const res = await fetch(`${WORKER_URL}/api/stats`)
  if (!res.ok) return null
  return res.json() as Promise<NetworkStats>
}
