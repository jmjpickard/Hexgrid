// HexGrid — Shared Types (Orchestration Platform)

export type SessionStatus = 'active' | 'disconnected'
export type MessageStatus = 'pending' | 'answered' | 'expired'
export type DeviceAuthStatus = 'pending' | 'approved' | 'consumed'

// ─── DATABASE ROWS ────────────────────────────────────────────────────────────

export interface UserRow {
  user_id: string
  email: string
  email_verified_at: number | null
  account_api_key_hash: string | null
  account_api_key_prefix: string | null
  created_at: number
}

export interface AuthCodeRow {
  email: string
  code_hash: string
  expires_at: number
  attempts_left: number
  created_at: number
}

export interface WebSessionRow {
  session_id: string
  user_id: string
  token_hash: string
  expires_at: number
  created_at: number
  revoked_at: number | null
}

export interface DeviceAuthRequestRow {
  device_code: string
  user_code: string
  user_id: string | null
  client_name: string | null
  status: DeviceAuthStatus
  created_at: number
  expires_at: number
  approved_at: number | null
  consumed_at: number | null
}

export interface CliTokenRow {
  token_id: string
  user_id: string
  token_hash: string
  token_prefix: string
  created_at: number
  expires_at: number | null
  last_used_at: number | null
  revoked_at: number | null
}

export interface AgentSessionRow {
  session_id: string
  account_id: string
  name: string
  repo_url: string | null
  description: string | null
  capabilities: string // JSON array
  hex_id: string
  status: SessionStatus
  last_heartbeat: number
  connected_at: number
  disconnected_at: number | null
}

export interface KnowledgeRow {
  id: string
  account_id: string
  session_id: string
  topic: string
  content: string
  tags: string // JSON array
  created_at: number
  updated_at: number
}

export interface MessageRow {
  id: string
  account_id: string
  from_session_id: string
  to_session_id: string
  question: string
  answer: string | null
  status: MessageStatus
  created_at: number
  answered_at: number | null
  expires_at: number
}

export interface ConnectionRow {
  id: string
  account_id: string
  session_a_id: string
  session_b_id: string
  interaction_count: number
  strength: number
  last_interaction: number
}

// ─── AUTH CONTEXT ─────────────────────────────────────────────────────────────

export interface SessionUser {
  user_id: string
  email: string
  email_verified_at: number | null
}

export interface AccountAuthContext {
  account_id: string
}

// ─── MCP TOOL I/O ─────────────────────────────────────────────────────────────

export interface ConnectSessionInput {
  name: string
  repo_url?: string
  description?: string
  capabilities?: string[]
}

export interface ConnectSessionOutput {
  session_id: string
  hex_id: string
  active_sessions: Array<{
    session_id: string
    name: string
    hex_id: string
    status: SessionStatus
  }>
}

export interface HeartbeatInput {
  session_id: string
}

export interface HeartbeatOutput {
  ok: boolean
  pending_messages: number
}

export interface ListSessionsOutput {
  sessions: Array<{
    session_id: string
    name: string
    repo_url: string | null
    description: string | null
    hex_id: string
    status: SessionStatus
    connected_at: number
  }>
}

export interface WriteKnowledgeInput {
  session_id: string
  topic: string
  content: string
  tags?: string[]
}

export interface WriteKnowledgeOutput {
  id: string
  topic: string
}

export interface SearchKnowledgeInput {
  query?: string
  tags?: string[]
  limit?: number
}

export interface SearchKnowledgeOutput {
  entries: Array<{
    id: string
    topic: string
    content: string
    tags: string[]
    session_name: string
    created_at: number
  }>
  total: number
}

export interface AskAgentInput {
  session_id: string
  to_session_id: string
  question: string
}

export interface AskAgentOutput {
  message_id: string
  to_session_id: string
  status: MessageStatus
}

export interface CheckMessagesInput {
  session_id: string
}

export interface CheckMessagesOutput {
  messages: Array<{
    message_id: string
    from_session_id: string
    from_session_name: string
    question: string
    created_at: number
  }>
  total: number
}

export interface RespondInput {
  session_id: string
  message_id: string
  answer: string
}

export interface RespondOutput {
  message_id: string
  status: MessageStatus
}

export interface GetResponseInput {
  message_id: string
}

export interface GetResponseOutput {
  message_id: string
  status: MessageStatus
  answer: string | null
}

// ─── CLOUDFLARE ENV ───────────────────────────────────────────────────────────

export interface Env {
  DB: D1Database
  ENVIRONMENT: string
  RESEND_API_KEY?: string
  AUTH_FROM_EMAIL?: string
  APP_URL?: string
  WORKER_PUBLIC_URL?: string
}
