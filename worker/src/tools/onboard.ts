// HexGrid — onboard MCP Tool
// Unauthenticated entry point: agent self-registers in one call.
// Returns hex_id, API key, credits, and MCP config.

import { z } from 'zod'
import type { Domain, Env, OnboardOutput } from '../lib/types'
import { assignHex, getNeighbours } from '../lib/h3'
import { classifyDomain } from '../lib/classify'
import { suggestPrice } from '../lib/pricing'
import {
  sanitiseAgentName,
  sanitiseDescription,
  sanitiseCapabilities,
  isValidDomain,
  isValidEmail,
} from '../lib/sanitise'
import {
  createUser,
  ensureCreditsAccount,
  creditCredits,
  getAllOccupiedHexIds,
  getHexByPublicKey,
  getUserByEmail,
  insertAgentApiKey,
  insertCreditsLedgerEntry,
  insertHex,
  markStarterCreditsGranted,
} from '../db/queries'
import { generateToken, keyPrefix, nowUnix, sha256 } from '../lib/auth'

const STARTER_CREDITS = 500

const DEFAULT_SCOPES = [
  'discover',
  'submit_task',
  'poll_tasks',
  'claim_task',
  'complete_task',
  'rate_task',
] as const

const availabilitySchema = z.object({
  timezone: z.string(),
  days: z.array(z.number()),
  hours_start: z.number(),
  hours_end: z.number(),
})

export const onboardSchema = z.object({
  agent_name: z.string().min(2).max(50),
  description: z.string().min(10).max(200),
  public_key: z.string().min(10).max(500),
  owner_email: z.string().email(),
  capabilities: z.array(z.string().max(50)).min(1).max(20),
  domain: z.string().optional(),
  price_per_task: z.number().int().min(1).max(10000).optional(),
  availability: availabilitySchema.optional(),
  mcp_endpoint: z.string().url().optional(),
})

export type OnboardInput = z.infer<typeof onboardSchema>

export async function onboard(
  input: OnboardInput,
  env: Env,
): Promise<OnboardOutput> {
  const appBase = (env.APP_URL ?? 'https://hexgrid.app').replace(/\/+$/, '')
  const workerBase = (env.WORKER_PUBLIC_URL ?? 'https://api.hexgrid.app').replace(/\/+$/, '')

  // ── Validate + sanitise ──────────────────────────────────────────────────
  if (!isValidEmail(input.owner_email)) {
    throw new Error('Invalid email address')
  }

  const agentName = sanitiseAgentName(input.agent_name)
  const description = sanitiseDescription(input.description)
  const capabilities = sanitiseCapabilities(input.capabilities)

  if (capabilities.length === 0) {
    throw new Error('At least one valid capability is required')
  }

  // ── Idempotency: return existing hex info if public_key already registered ─
  const existing = await getHexByPublicKey(env.DB, input.public_key)
  if (existing) {
    const neighbours = getNeighbours(existing.hex_id)
    return {
      hex_id: existing.hex_id,
      api_key: '(already registered — use existing key)',
      domain: existing.domain,
      domain_auto: false,
      price_per_task: existing.price_per_task,
      price_auto: false,
      neighbours,
      mcp_config: buildMcpConfig(workerBase),
      explorer_url: `${appBase}/?hex=${existing.hex_id}`,
      starter_credits: 0,
    }
  }

  // ── Auto-classify domain ─────────────────────────────────────────────────
  let domain: Domain
  let domainAuto = false

  if (input.domain && isValidDomain(input.domain)) {
    domain = input.domain
  } else {
    const classified = classifyDomain(capabilities, description)
    domain = classified.domain
    domainAuto = true
  }

  // ── Suggest pricing ──────────────────────────────────────────────────────
  let pricePerTask: number
  let priceAuto = false

  if (input.price_per_task !== undefined) {
    pricePerTask = input.price_per_task
  } else {
    pricePerTask = await suggestPrice(env.DB, domain)
    priceAuto = true
  }

  // ── Default availability ─────────────────────────────────────────────────
  const availability = input.availability ?? {
    timezone: 'UTC',
    days: [0, 1, 2, 3, 4, 5, 6],
    hours_start: 0,
    hours_end: 0, // 0-0 = always available
  }

  // ── Assign hex position ──────────────────────────────────────────────────
  const occupiedHexes = await getAllOccupiedHexIds(env.DB)
  const hexId = await assignHex(domain, occupiedHexes)
  const neighbours = getNeighbours(hexId)

  // ── Persist hex ──────────────────────────────────────────────────────────
  const now = nowUnix()

  await insertHex(env.DB, {
    hex_id: hexId,
    public_key: input.public_key,
    owner_email: input.owner_email,
    agent_name: agentName,
    description,
    domain,
    capabilities: JSON.stringify(capabilities),
    price_per_task: pricePerTask,
    availability: JSON.stringify(availability),
    allowed_actions: JSON.stringify(['read', 'analyse', 'respond']),
    created_at: now,
    mcp_endpoint: input.mcp_endpoint ?? null,
    onboarded_via: 'mcp',
  })

  // ── Create user (skip email verification — agents can't check email) ─────
  let user = await getUserByEmail(env.DB, input.owner_email)
  if (!user) {
    const userId = crypto.randomUUID()
    await createUser(env.DB, userId, input.owner_email, now)
    user = await getUserByEmail(env.DB, input.owner_email)
  }
  if (!user) throw new Error('Failed to create user')

  // ── Credits ──────────────────────────────────────────────────────────────
  await ensureCreditsAccount(env.DB, input.owner_email)

  let starterCredits = 0
  if (!user.starter_credits_granted_at) {
    await creditCredits(env.DB, input.owner_email, STARTER_CREDITS, now)
    await insertCreditsLedgerEntry(env.DB, {
      entry_id: crypto.randomUUID(),
      account_id: input.owner_email,
      delta: STARTER_CREDITS,
      reason: 'signup_bonus',
      task_id: null,
      metadata: JSON.stringify({ source: 'onboard_mcp' }),
      created_at: now,
    })
    await markStarterCreditsGranted(env.DB, user.user_id, now)
    starterCredits = STARTER_CREDITS
  }

  // ── Generate API key ─────────────────────────────────────────────────────
  const plaintextKey = `hgk_live_${generateToken(24)}`
  const keyHash = await sha256(plaintextKey)
  const keyId = crypto.randomUUID()

  await insertAgentApiKey(env.DB, {
    key_id: keyId,
    user_id: user.user_id,
    hex_id: hexId,
    key_hash: keyHash,
    key_prefix: keyPrefix(plaintextKey),
    name: `${agentName} onboard key`,
    scopes: JSON.stringify([...DEFAULT_SCOPES]),
    created_at: now,
  })

  return {
    hex_id: hexId,
    api_key: plaintextKey,
    domain,
    domain_auto: domainAuto,
    price_per_task: pricePerTask,
    price_auto: priceAuto,
    neighbours,
    mcp_config: buildMcpConfig(workerBase, plaintextKey),
    explorer_url: `${appBase}/?hex=${hexId}`,
    starter_credits: starterCredits,
  }
}

function buildMcpConfig(workerBase: string, apiKey?: string): string {
  return JSON.stringify({
    mcpServers: {
      hexgrid: {
        url: `${workerBase}/mcp`,
        headers: {
          Authorization: `Bearer ${apiKey ?? 'hgk_live_REPLACE_WITH_AGENT_KEY'}`,
        },
      },
    },
  }, null, 2)
}
