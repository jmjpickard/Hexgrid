// HexGrid — MCP Server
// Any MCP-compatible agent connects here with one config line.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Env } from './lib/types'
import { registerHex, registerHexSchema } from './tools/register'
import { discoverAgents, discoverAgentsSchema } from './tools/discover'

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: 'HexGrid',
    version: '0.1.0',
    description: 'The agent coordination network. Register your agent, earn credits, find specialist agents.',
  })

  // ── register_hex ───────────────────────────────────────────────────────────
  server.tool(
    'register_hex',
    'Register your agent on the HexGrid network. Assigns a hex address, enables discovery by other agents, and allows you to earn credits for completed tasks. Your private key never leaves your machine — only provide your public key here.',
    registerHexSchema.shape,
    async (input) => {
      try {
        const result = await registerHex(input as any, env)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }]
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
          isError: true,
        }
      }
    }
  )

  // ── discover_agents ────────────────────────────────────────────────────────
  server.tool(
    'discover_agents',
    'Find specialist agents on the HexGrid network. Returns top agents for a given domain, ordered by reputation score and availability. Use this before submitting a task to find the best match within your budget.',
    discoverAgentsSchema.shape,
    async (input) => {
      try {
        const result = await discoverAgents(input as any, env)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }]
        }
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
          isError: true,
        }
      }
    }
  )

  // ── get_reputation ─────────────────────────────────────────────────────────
  server.tool(
    'get_reputation',
    'Get the reputation score and stats for any hex on the network.',
    { hex_id: z.string() },
    async ({ hex_id }) => {
      try {
        const { getHexById } = await import('./db/queries')
        const hex = await getHexById(env.DB, hex_id)
        if (!hex) {
          return { content: [{ type: 'text' as const, text: 'Hex not found' }], isError: true }
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              hex_id: hex.hex_id,
              agent_name: hex.agent_name,
              domain: hex.domain,
              reputation_score: hex.reputation_score,
              total_tasks: hex.total_tasks,
              price_per_task: hex.price_per_task,
              description: hex.description,
            }, null, 2)
          }]
        }
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  // ── check_balance ──────────────────────────────────────────────────────────
  server.tool(
    'check_balance',
    'Check the credit balance for an account.',
    { account_id: z.string() },
    async ({ account_id }) => {
      try {
        const { getCredits } = await import('./db/queries')
        const credits = await getCredits(env.DB, account_id)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(credits ?? { balance: 0, total_earned: 0, total_spent: 0 }, null, 2)
          }]
        }
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true }
      }
    }
  )

  return server
}
