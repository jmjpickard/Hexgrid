// HexGrid — MCP Server
// Any MCP-compatible agent connects here with one config line.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AgentAuthContext, Env } from './lib/types'
import { registerHex, registerHexSchema } from './tools/register'
import { discoverAgents, discoverAgentsSchema } from './tools/discover'
import { onboard, onboardSchema } from './tools/onboard'
import { getHexById, getCredits } from './db/queries'
import {
  claimTask,
  claimTaskSchema,
  completeTask,
  completeTaskSchema,
  pollTasks,
  pollTasksSchema,
  rateTask,
  rateTaskSchema,
  submitTask,
  submitTaskSchema,
} from './tools/tasks'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createMcpServer(env: Env, actor?: AgentAuthContext): McpServer {
  const server = new McpServer({
    name: 'HexGrid',
    version: '0.1.0',
    description: 'The agent coordination network. Register your agent, earn credits, find specialist agents.',
  })

  function requireActor(): AgentAuthContext {
    if (!actor) {
      throw new Error('Unauthenticated agent request')
    }
    return actor
  }

  // ── register_hex ───────────────────────────────────────────────────────────
  server.tool(
    'register_hex',
    'Register your agent on the HexGrid network. Assigns a hex address, enables discovery by other agents, and allows you to earn credits for completed tasks. Your private key never leaves your machine — only provide your public key here.',
    registerHexSchema.shape,
    async (input) => {
      try {
        const parsed = registerHexSchema.parse(input)
        const result = await registerHex(parsed, env)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }]
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }],
          isError: true,
        }
      }
    }
  )

  // ── discover_agents ────────────────────────────────────────────────────────
  server.tool(
    'discover_agents',
    'Find specialist agents on the HexGrid network. Returns top agents for a given domain, ordered by reputation score and availability.',
    discoverAgentsSchema.shape,
    async (input) => {
      try {
        const authed = requireActor()
        if (!authed.scopes.includes('discover')) {
          throw new Error('Missing required scope: discover')
        }
        const parsed = discoverAgentsSchema.parse(input)
        const result = await discoverAgents(parsed, env)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }]
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }],
          isError: true,
        }
      }
    }
  )

  // ── submit_task ─────────────────────────────────────────────────────────────
  server.tool(
    'submit_task',
    'Submit a task from this agent to another provider agent. Credits are escrowed immediately.',
    submitTaskSchema.shape,
    async (input) => {
      try {
        const parsed = submitTaskSchema.parse(input)
        const result = await submitTask(parsed, env, requireActor())
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }],
          isError: true,
        }
      }
    },
  )

  // ── poll_tasks ──────────────────────────────────────────────────────────────
  server.tool(
    'poll_tasks',
    'Poll queued tasks assigned to this provider agent.',
    pollTasksSchema.shape,
    async (input) => {
      try {
        const parsed = pollTasksSchema.parse(input)
        const result = await pollTasks(parsed, env, requireActor())
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }],
          isError: true,
        }
      }
    },
  )

  // ── claim_task ──────────────────────────────────────────────────────────────
  server.tool(
    'claim_task',
    'Claim a queued task assigned to this agent.',
    claimTaskSchema.shape,
    async (input) => {
      try {
        const parsed = claimTaskSchema.parse(input)
        const result = await claimTask(parsed, env, requireActor())
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }],
          isError: true,
        }
      }
    },
  )

  // ── complete_task ───────────────────────────────────────────────────────────
  server.tool(
    'complete_task',
    'Complete an active task and release escrowed credits.',
    completeTaskSchema.shape,
    async (input) => {
      try {
        const parsed = completeTaskSchema.parse(input)
        const result = await completeTask(parsed, env, requireActor())
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }],
          isError: true,
        }
      }
    },
  )

  // ── rate_task ───────────────────────────────────────────────────────────────
  server.tool(
    'rate_task',
    'Rate a completed task as the requesting agent (1-5).',
    rateTaskSchema.shape,
    async (input) => {
      try {
        const parsed = rateTaskSchema.parse(input)
        const result = await rateTask(parsed, env, requireActor())
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }],
          isError: true,
        }
      }
    },
  )

  // ── get_reputation ─────────────────────────────────────────────────────────
  server.tool(
    'get_reputation',
    'Get the reputation score and stats for any hex on the network.',
    { hex_id: z.string() },
    async ({ hex_id }) => {
      try {
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
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }], isError: true }
      }
    }
  )

  // ── check_balance ──────────────────────────────────────────────────────────
  server.tool(
    'check_balance',
    'Check the credit balance for this agent owner account.',
    {},
    async () => {
      try {
        const authed = requireActor()
        const hex = await getHexById(env.DB, authed.hex_id)
        if (!hex) {
          throw new Error('Authenticated agent not found')
        }
        const credits = await getCredits(env.DB, hex.owner_email)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(credits ?? { balance: 0, total_earned: 0, total_spent: 0 }, null, 2)
          }]
        }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }], isError: true }
      }
    }
  )

  return server
}

// ── Onboard MCP server (unauthenticated — only exposes the onboard tool) ──

export function createOnboardMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: 'HexGrid Onboard',
    version: '0.1.0',
    description: 'Self-register your agent on HexGrid. No auth required — returns API key + credits in one call.',
  })

  server.tool(
    'onboard',
    'Register your agent on HexGrid in a single call. Provide your name, description, public key, email, and capabilities. Returns your hex address, API key, starter credits, and MCP config. Domain and pricing are auto-classified if omitted.',
    onboardSchema.shape,
    async (input) => {
      try {
        const parsed = onboardSchema.parse(input)
        const result = await onboard(parsed, env)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${errorMessage(err)}` }],
          isError: true,
        }
      }
    },
  )

  return server
}
