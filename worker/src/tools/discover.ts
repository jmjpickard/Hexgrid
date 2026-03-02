// HexGrid — discover_agents MCP Tool

import { z } from 'zod'
import type { Env, AgentSummary, DiscoverAgentsOutput, Domain } from '../lib/types'
import { discoverHexes } from '../db/queries'
import { sanitiseTaskDescription, isValidDomain } from '../lib/sanitise'

export const discoverAgentsSchema = z.object({
  domain: z.string(),
  task_description: z.string().min(5).max(2000),
  max_credits: z.number().int().min(1).max(10000),
  requester_hex: z.string().optional(),
})

export type DiscoverAgentsInput = z.infer<typeof discoverAgentsSchema>

function isHourInWindow(hour: number, start: number, end: number): boolean {
  // Treat equal start/end as "always available".
  if (start === end) return true
  if (start < end) return hour >= start && hour < end
  // Overnight window, e.g. 20 -> 8
  return hour >= start || hour < end
}

function getDayHourInTimezone(date: Date, timezone: string): { day: number; hour: number } {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      hour12: false,
    })
    const parts = formatter.formatToParts(date)
    const weekday = parts.find(p => p.type === 'weekday')?.value ?? 'Sun'
    const hourValue = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
    const dayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    }
    return {
      day: dayMap[weekday] ?? date.getUTCDay(),
      hour: Number.isFinite(hourValue) ? hourValue : date.getUTCHours(),
    }
  } catch {
    return { day: date.getUTCDay(), hour: date.getUTCHours() }
  }
}

export async function discoverAgents(
  input: DiscoverAgentsInput,
  env: Env
): Promise<DiscoverAgentsOutput> {

  // ── Validate domain ────────────────────────────────────────────────────────
  if (!isValidDomain(input.domain)) {
    throw new Error('Invalid domain. Must be one of: coding, data, legal, finance, marketing, writing, other')
  }

  const domain: Domain = input.domain

  // ── Sanitise task description (don't leak it, just use for matching) ───────
  const { flagged, flags } = await sanitiseTaskDescription(input.task_description)

  if (flagged) {
    throw new Error(`Task description contains disallowed patterns: ${flags.join(', ')}`)
  }

  // ── Query ──────────────────────────────────────────────────────────────────
  const rows = await discoverHexes(env.DB, domain, input.max_credits, 5)

  // ── Check availability ─────────────────────────────────────────────────────
  const now = new Date()
  const agents: AgentSummary[] = rows.map(row => {
    let availability: { days: number[]; hours_start: number; hours_end: number; timezone: string }
    try {
      availability = JSON.parse(row.availability)
    } catch {
      availability = { days: [0,1,2,3,4,5,6], hours_start: 0, hours_end: 23, timezone: 'UTC' }
    }

    const { day, hour } = getDayHourInTimezone(now, availability.timezone ?? 'UTC')

    const availableNow =
      availability.days.includes(day) &&
      isHourInWindow(hour, availability.hours_start, availability.hours_end)

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
      domain: row.domain,
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
