// HexGrid — API fetch helpers (Orchestration Platform)

const WORKER_URL = process.env.NEXT_PUBLIC_WORKER_URL ?? ''

export interface AgentSession {
  session_id: string
  account_id: string
  name: string
  repo_url: string | null
  description: string | null
  capabilities: string
  hex_id: string
  status: 'active' | 'disconnected'
  last_heartbeat: number
  connected_at: number
  disconnected_at: number | null
}

export interface KnowledgeEntry {
  id: string
  account_id: string
  session_id: string
  topic: string
  content: string
  tags: string[]
  session_name: string
  created_at: number
  updated_at: number
}

export interface Connection {
  id: string
  account_id: string
  session_a_id: string
  session_b_id: string
  interaction_count: number
  strength: number
  last_interaction: number
}

export interface MessageEntry {
  id: string
  from_session_id: string
  to_session_id: string
  from_session_name: string
  to_session_name: string
  question: string
  answer: string | null
  status: 'pending' | 'answered' | 'expired'
  created_at: number
  answered_at: number | null
}

export interface AccountStats {
  active_sessions: number
  total_knowledge: number
  total_messages: number
  total_connections: number
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${WORKER_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

export async function fetchMe(): Promise<{ user_id: string; email: string } | null> {
  const res = await authFetch('/api/me')
  if (!res.ok) return null
  return res.json() as Promise<{ user_id: string; email: string }>
}

export async function fetchSessions(): Promise<AgentSession[]> {
  const res = await authFetch('/api/sessions')
  if (!res.ok) return []
  const data = await res.json() as { sessions: AgentSession[] }
  return data.sessions
}

export async function fetchKnowledge(limit = 50): Promise<KnowledgeEntry[]> {
  const res = await authFetch(`/api/knowledge?limit=${limit}`)
  if (!res.ok) return []
  const data = await res.json() as { entries: KnowledgeEntry[] }
  return data.entries
}

export async function fetchConnections(): Promise<Connection[]> {
  const res = await authFetch('/api/connections')
  if (!res.ok) return []
  const data = await res.json() as { connections: Connection[] }
  return data.connections
}

export async function fetchMessages(limit = 50): Promise<MessageEntry[]> {
  const res = await authFetch(`/api/messages?limit=${limit}`)
  if (!res.ok) return []
  const data = await res.json() as { messages: MessageEntry[] }
  return data.messages
}

export async function fetchStats(): Promise<AccountStats | null> {
  const res = await authFetch('/api/stats')
  if (!res.ok) return null
  return res.json() as Promise<AccountStats>
}

export async function generateApiKey(): Promise<{ key: string; key_prefix: string } | null> {
  const res = await authFetch('/api/account/api-key', { method: 'POST' })
  if (!res.ok) return null
  return res.json() as Promise<{ key: string; key_prefix: string }>
}

export async function startAuth(email: string): Promise<{ ok: boolean; dev_code?: string }> {
  const res = await authFetch('/auth/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  return res.json() as Promise<{ ok: boolean; dev_code?: string }>
}

export async function verifyAuth(email: string, code: string): Promise<{ ok: boolean; error?: string }> {
  const res = await authFetch('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  })
  return res.json() as Promise<{ ok: boolean; error?: string }>
}

export async function logout(): Promise<void> {
  await authFetch('/auth/logout', { method: 'POST' })
}
