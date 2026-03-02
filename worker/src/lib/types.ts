// HexGrid — Shared Types

export type Domain =
  | 'coding'
  | 'data'
  | 'legal'
  | 'finance'
  | 'marketing'
  | 'writing'
  | 'other'

export const DOMAINS: readonly Domain[] = [
  'coding', 'data', 'legal', 'finance', 'marketing', 'writing', 'other',
] as const

export type TaskStatus =
  | 'queued'
  | 'active'
  | 'complete'
  | 'disputed'
  | 'refunded'

export type Outcome = 'success' | 'failure' | 'disputed'

// ─── DATABASE ROWS ────────────────────────────────────────────────────────────

export interface HexRow {
  hex_id: string
  public_key: string
  owner_email: string
  agent_name: string
  description: string
  domain: Domain
  capabilities: string        // JSON string
  price_per_task: number
  availability: string        // JSON string
  allowed_actions: string     // JSON string
  reputation_score: number
  total_tasks: number
  active: number
  created_at: number
}

export interface TaskRow {
  task_id: string
  from_hex: string
  to_hex: string
  description: string
  description_hash: string
  credits_escrowed: number
  status: TaskStatus
  created_at: number
  claimed_at: number | null
  completed_at: number | null
  result_hash: string | null
}

export interface InteractionRow {
  interaction_id: string
  task_id: string
  provider_hex: string
  consumer_hex: string
  outcome: Outcome
  rating: number | null
  credits_transferred: number
  platform_fee: number
  created_at: number
}

export interface CreditsRow {
  account_id: string
  balance: number
  total_earned: number
  total_spent: number
  created_at: number
  updated_at: number
}

export interface CreditsLedgerRow {
  entry_id: string
  account_id: string
  delta: number
  reason: string
  task_id: string | null
  metadata: string
  created_at: number
}

export interface UserRow {
  user_id: string
  email: string
  email_verified_at: number | null
  starter_credits_granted_at: number | null
  created_at: number
}

export interface AuthCodeRow {
  email: string
  code_hash: string
  expires_at: number
  attempts_left: number
  created_at: number
}

export interface SessionRow {
  session_id: string
  user_id: string
  token_hash: string
  expires_at: number
  created_at: number
  revoked_at: number | null
}

export interface AgentApiKeyRow {
  key_id: string
  user_id: string
  hex_id: string
  key_hash: string
  key_prefix: string
  name: string
  scopes: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

export interface SessionUser {
  user_id: string
  email: string
  email_verified_at: number | null
  starter_credits_granted_at: number | null
}

export interface AgentAuthContext {
  key_id: string
  user_id: string
  hex_id: string
  scopes: string[]
}

// ─── MCP TOOL INPUTS ──────────────────────────────────────────────────────────

export interface RegisterHexInput {
  public_key: string
  domain: Domain
  capabilities: string[]
  price_per_task: number
  availability: {
    timezone: string
    days: number[]          // 0=Sun ... 6=Sat
    hours_start: number     // 0-23
    hours_end: number       // 0-23
  }
  owner_email: string
  agent_name: string
  description: string
  allowed_actions?: string[]
}

export interface DiscoverAgentsInput {
  domain: Domain
  task_description: string
  max_credits: number
  requester_hex?: string
}

// ─── MCP TOOL OUTPUTS ─────────────────────────────────────────────────────────

export interface RegisterHexOutput {
  hex_id: string
  neighbours: string[]
  mcp_config: string      // JSON snippet
  explorer_url: string
}

export interface AgentSummary {
  hex_id: string
  agent_name: string
  description: string
  domain: Domain
  reputation_score: number
  total_tasks: number
  price_per_task: number
  capabilities: string[]
  available_now: boolean
}

export interface DiscoverAgentsOutput {
  agents: AgentSummary[]
  total_found: number
}

// ─── CLOUDFLARE ENV ───────────────────────────────────────────────────────────

export interface Env {
  DB: D1Database
  ENVIRONMENT: string
  RESEND_API_KEY?: string
  AUTH_FROM_EMAIL?: string
  APP_URL?: string
}
