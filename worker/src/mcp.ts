// HexGrid — MCP Server (Orchestration Platform)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AccountAuthContext, Env } from './lib/types'
import {
  connectSession, connectSessionSchema,
  heartbeat, heartbeatSchema,
  listSessions, listSessionsSchema,
  disconnect, disconnectSchema,
  writeKnowledge, writeKnowledgeSchema,
  searchKnowledge, searchKnowledgeSchema,
  askAgent, askAgentSchema,
  checkMessages, checkMessagesSchema,
  respond, respondSchema,
  getResponse, getResponseSchema,
} from './tools'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function fail(err: unknown): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${errorMessage(err)}` }], isError: true }
}

export function createMcpServer(env: Env, account: AccountAuthContext): McpServer {
  const server = new McpServer({
    name: 'HexGrid',
    version: '0.2.0',
    description: 'Multi-agent orchestration platform. Connect your agents, share knowledge, coordinate work.',
  })

  // ── connect_session ─────────────────────────────────────────────────────────
  server.tool(
    'connect_session',
    'Connect this agent session to HexGrid. Call once on startup. Returns your session ID and a list of other active sessions on your account.',
    connectSessionSchema.shape,
    async (input) => {
      try {
        const parsed = connectSessionSchema.parse(input)
        return ok(await connectSession(parsed, env, account))
      } catch (err) { return fail(err) }
    },
  )

  // ── heartbeat ───────────────────────────────────────────────────────────────
  server.tool(
    'heartbeat',
    'Send a heartbeat to keep this session alive. Call every 5 minutes. Returns count of pending messages.',
    heartbeatSchema.shape,
    async (input) => {
      try {
        const parsed = heartbeatSchema.parse(input)
        return ok(await heartbeat(parsed, env, account))
      } catch (err) { return fail(err) }
    },
  )

  // ── list_sessions ───────────────────────────────────────────────────────────
  server.tool(
    'list_sessions',
    'List all active agent sessions on your account. See which other agents are currently connected.',
    listSessionsSchema.shape,
    async () => {
      try {
        return ok(await listSessions(env, account))
      } catch (err) { return fail(err) }
    },
  )

  // ── disconnect ──────────────────────────────────────────────────────────────
  server.tool(
    'disconnect',
    'Disconnect this agent session from HexGrid. Call when shutting down.',
    disconnectSchema.shape,
    async (input) => {
      try {
        const parsed = disconnectSchema.parse(input)
        return ok(await disconnect(parsed, env, account))
      } catch (err) { return fail(err) }
    },
  )

  // ── write_knowledge ─────────────────────────────────────────────────────────
  server.tool(
    'write_knowledge',
    'Write a knowledge entry to the shared store. All sessions on your account can search it. Use this to share insights about your repo, architecture decisions, or useful context.',
    writeKnowledgeSchema.shape,
    async (input) => {
      try {
        const parsed = writeKnowledgeSchema.parse(input)
        return ok(await writeKnowledge(parsed, env, account))
      } catch (err) { return fail(err) }
    },
  )

  // ── search_knowledge ────────────────────────────────────────────────────────
  server.tool(
    'search_knowledge',
    'Search the shared knowledge store. Find insights written by any session on your account. Filter by query text or tags.',
    searchKnowledgeSchema.shape,
    async (input) => {
      try {
        const parsed = searchKnowledgeSchema.parse(input)
        return ok(await searchKnowledge(parsed, env, account))
      } catch (err) { return fail(err) }
    },
  )

  // ── ask_agent ───────────────────────────────────────────────────────────────
  server.tool(
    'ask_agent',
    'Send a question to another active session. The target agent will see it when they call check_messages. Returns a message_id you can use with get_response to check for the answer.',
    askAgentSchema.shape,
    async (input) => {
      try {
        const parsed = askAgentSchema.parse(input)
        return ok(await askAgent(parsed, env, account))
      } catch (err) { return fail(err) }
    },
  )

  // ── check_messages ──────────────────────────────────────────────────────────
  server.tool(
    'check_messages',
    'Check for pending questions addressed to this session. Call periodically or when another session may need help.',
    checkMessagesSchema.shape,
    async (input) => {
      try {
        const parsed = checkMessagesSchema.parse(input)
        return ok(await checkMessages(parsed, env, account))
      } catch (err) { return fail(err) }
    },
  )

  // ── respond ─────────────────────────────────────────────────────────────────
  server.tool(
    'respond',
    'Answer a pending question. The asking agent will see your response when they call get_response.',
    respondSchema.shape,
    async (input) => {
      try {
        const parsed = respondSchema.parse(input)
        return ok(await respond(parsed, env, account))
      } catch (err) { return fail(err) }
    },
  )

  // ── get_response ────────────────────────────────────────────────────────────
  server.tool(
    'get_response',
    'Check if a question you asked has been answered. Returns the answer if available, or the current status (pending/expired).',
    getResponseSchema.shape,
    async (input) => {
      try {
        const parsed = getResponseSchema.parse(input)
        return ok(await getResponse(parsed, env, account))
      } catch (err) { return fail(err) }
    },
  )

  return server
}
