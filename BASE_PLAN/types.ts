// HexGrid — Shared Types

export type Domain =
  | 'coding'
  | 'data'
  | 'legal'
  | 'finance'
  | 'marketing'
  | 'writing'
  | 'other'

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

export interface SubmitTaskInput {
  from_hex: string
  to_hex: string
  description: string
  credits_offered: number
}

export interface PollTasksInput {
  hex_id: string
  api_key: string
}

export interface CompleteTaskInput {
  task_id: string
  hex_id: string
  result: string
  api_key: string
}

export interface GetReputationInput {
  hex_id: string
}

export interface CheckBalanceInput {
  account_id: string
}

export interface RateInteractionInput {
  task_id: string
  rating: number      // 1-5
  hex_id: string      // consumer's hex
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
  TASK_QUEUE: Queue
  ENVIRONMENT: string
}
