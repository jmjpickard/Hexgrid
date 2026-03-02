// HexGrid — discover_agents MCP Tool

import { z } from 'zod'
import type { Env, AgentSummary, DiscoverAgentsOutput, Domain } from '../lib/types'
import { discoverHexes } from '../db/queries'
import { sanitiseTaskDescription, isValidDomain } from '../lib/sanitise'
import { DOMAIN_COLOURS } from '../lib/h3'

export const discoverAgentsSchema = z.object({
  domain: z.string(),
  task_description: z.string().min(5).max(2000),
  max_credits: z.number().int().min(1).max(10000),
  requester_hex: z.string().optional(),
})

export async function discoverAgents(
  input: z.infer<typeof discoverAgentsSchema>,
  env: Env
): Promise<DiscoverAgentsOutput> {

  // ── Validate domain ────────────────────────────────────────────────────────
  if (!isValidDomain(input.domain)) {
    throw new Error(`Invalid domain. Must be one of: coding, data, legal, finance, marketing, writing, other`)
  }

  // ── Sanitise task description (don't leak it, just use for matching) ───────
  const { clean, flagged, flags } = await sanitiseTaskDescription(input.task_description)

  if (flagged) {
    throw new Error(`Task description contains disallowed patterns: ${flags.join(', ')}`)
  }

  // ── Query ──────────────────────────────────────────────────────────────────
  const rows = await discoverHexes(env.DB, input.domain as Domain, input.max_credits, 5)

  // ── Check availability ─────────────────────────────────────────────────────
  const now = new Date()
  const currentDay = now.getUTCDay()
  const currentHour = now.getUTCHours()

  const agents: AgentSummary[] = rows.map(row => {
    let availability: { days: number[]; hours_start: number; hours_end: number; timezone: string }
    try {
      availability = JSON.parse(row.availability)
    } catch {
      availability = { days: [0,1,2,3,4,5,6], hours_start: 0, hours_end: 23, timezone: 'UTC' }
    }

    const availableNow =
      availability.days.includes(currentDay) &&
      currentHour >= availability.hours_start &&
      currentHour <= availability.hours_end

    let capabilities: string[]
    try {
      capabilities = JSON.parse(row.capabilities)
    } catch {
      capabilities = []
    }

    return {
      hex_id: row.hex_id,
      agent_name: row.agent_name,
      description: row.description,
      domain: row.domain as Domain,
      reputation_score: Math.round(row.reputation_score * 10) / 10,
      total_tasks: row.total_tasks,
      price_per_task: row.price_per_task,
      capabilities,
      available_now: availableNow,
    }
  })

  // Sort: available first, then by reputation
  agents.sort((a, b) => {
    if (a.available_now !== b.available_now) return a.available_now ? -1 : 1
    return b.reputation_score - a.reputation_score
  })

  return {
    agents,
    total_found: agents.length,
  }
}
