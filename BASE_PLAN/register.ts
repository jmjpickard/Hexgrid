// HexGrid — register_hex MCP Tool

import { z } from 'zod'
import type { Env, RegisterHexOutput } from '../lib/types'
import { assignHex, getNeighbours, getDomainBaseCell } from '../lib/h3'
import {
  sanitiseAgentName,
  sanitiseDescription,
  sanitiseCapabilities,
  isValidDomain,
  isValidEmail,
  isValidAvailability,
} from '../lib/sanitise'
import {
  getHexByPublicKey,
  getAllOccupiedHexIds,
  insertHex,
  ensureCreditsAccount,
} from '../db/queries'

export const registerHexSchema = z.object({
  public_key: z.string().min(10).max(500),
  domain: z.string(),
  capabilities: z.array(z.string()).min(1).max(20),
  price_per_task: z.number().int().min(1).max(10000),
  availability: z.object({
    timezone: z.string(),
    days: z.array(z.number()),
    hours_start: z.number(),
    hours_end: z.number(),
  }),
  owner_email: z.string().email(),
  agent_name: z.string().min(2).max(50),
  description: z.string().min(10).max(200),
  allowed_actions: z.array(z.string()).optional(),
})

export async function registerHex(
  input: z.infer<typeof registerHexSchema>,
  env: Env
): Promise<RegisterHexOutput> {

  // ── Validate ───────────────────────────────────────────────────────────────
  if (!isValidDomain(input.domain)) {
    throw new Error(`Invalid domain. Must be one of: coding, data, legal, finance, marketing, writing, other`)
  }

  if (!isValidEmail(input.owner_email)) {
    throw new Error('Invalid email address')
  }

  if (!isValidAvailability(input.availability)) {
    throw new Error('Invalid availability format')
  }

  // ── Check for duplicate public key ─────────────────────────────────────────
  const existing = await getHexByPublicKey(env.DB, input.public_key)
  if (existing) {
    throw new Error(`Public key already registered as hex ${existing.hex_id}. Each agent can only have one hex.`)
  }

  // ── Sanitise ───────────────────────────────────────────────────────────────
  const agentName = sanitiseAgentName(input.agent_name)
  const description = sanitiseDescription(input.description)
  const capabilities = sanitiseCapabilities(input.capabilities)
  const domain = input.domain as any

  // ── Assign hex position ────────────────────────────────────────────────────
  const occupiedHexes = await getAllOccupiedHexIds(env.DB)
  const hexId = await assignHex(domain, occupiedHexes)
  const neighbours = getNeighbours(hexId)

  // ── Persist ────────────────────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000)

  await insertHex(env.DB, {
    hex_id: hexId,
    public_key: input.public_key,
    owner_email: input.owner_email,
    agent_name: agentName,
    description,
    domain,
    capabilities: JSON.stringify(capabilities),
    price_per_task: input.price_per_task,
    availability: JSON.stringify(input.availability),
    allowed_actions: JSON.stringify(input.allowed_actions ?? ['read', 'analyse', 'respond']),
    created_at: now,
  })

  await ensureCreditsAccount(env.DB, input.owner_email)

  // ── Build MCP config snippet ───────────────────────────────────────────────
  const mcpConfig = JSON.stringify({
    mcpServers: {
      hexgrid: {
        url: 'https://mcp.hexgrid.xyz/sse',
        apiKey: `hexgrid_${hexId}_${input.public_key.slice(0, 8)}`,
      }
    }
  }, null, 2)

  return {
    hex_id: hexId,
    neighbours,
    mcp_config: mcpConfig,
    explorer_url: `https://hexgrid.xyz/hex/${hexId}`,
  }
}
