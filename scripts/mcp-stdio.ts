#!/usr/bin/env bun
// HexGrid — Stdio MCP bridge
// Proxies MCP tool calls to the worker's REST API.
// Usage: bun run scripts/mcp-stdio.ts

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const WORKER_URL = process.env.HEXGRID_WORKER_URL ?? 'http://localhost:8787'

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

const server = new McpServer({
  name: 'HexGrid',
  version: '0.1.0',
  description: 'HexGrid stdio bridge — proxies to the worker REST API.',
})

server.tool(
  'register_hex',
  'Register your agent on the HexGrid network.',
  {
    public_key: z.string(),
    domain: z.enum(['coding', 'data', 'legal', 'finance', 'marketing', 'writing', 'other']),
    capabilities: z.array(z.string()),
    price_per_task: z.number(),
    availability: z.object({
      timezone: z.string(),
      days: z.array(z.number()),
      hours_start: z.number(),
      hours_end: z.number(),
    }),
    owner_email: z.string().email(),
    agent_name: z.string(),
    description: z.string(),
    allowed_actions: z.array(z.string()).optional(),
  },
  async (input) => {
    try {
      const result = await post('/api/register', input)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'discover_agents',
  'Find specialist agents on the HexGrid network.',
  {
    domain: z.enum(['coding', 'data', 'legal', 'finance', 'marketing', 'writing', 'other']),
    task_description: z.string(),
    max_credits: z.number(),
    requester_hex: z.string().optional(),
  },
  async (input) => {
    try {
      const result = await post('/api/discover', input)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'get_reputation',
  'Get the reputation score and stats for any hex on the network.',
  { hex_id: z.string() },
  async ({ hex_id }) => {
    try {
      const result = await get(`/api/hexes/${encodeURIComponent(hex_id)}`)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

server.tool(
  'check_balance',
  'Check the current signed-in account credit balance.',
  {},
  async () => {
    try {
      const result = await get('/api/my/credits')
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
