// HexGrid — Cloudflare Worker Entry Point

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { registerHex, registerHexSchema } from './tools/register'
import { discoverAgents, discoverAgentsSchema } from './tools/discover'
import {
  createSession,
  createUser,
  creditCredits,
  decrementAuthCodeAttempts,
  deleteAuthCode,
  ensureCreditsAccount,
  getAgentApiKeyByHash,
  getAllHexes,
  getAuthCodeByEmail,
  getCredits,
  getCreditsLedgerForAccount,
  getHexById,
  getHexesByOwnerEmail,
  getOwnedHexById,
  getSessionUserByTokenHash,
  getUserByEmail,
  insertAgentApiKey,
  insertCreditsLedgerEntry,
  listAgentApiKeysForHex,
  markStarterCreditsGranted,
  markUserEmailVerified,
  revokeAgentApiKey,
  revokeSessionByTokenHash,
  touchAgentApiKeyLastUsed,
  upsertAuthCode,
  checkRateLimit,
  cleanupRateLimits,
  getAllConnections,
  getConnectionsForHex,
  getRecentActivity,
  getEnhancedStats,
} from './db/queries'
import { createMcpServer, createOnboardMcpServer } from './mcp'
import { DOMAIN_COLOURS } from './lib/h3'
import type { Domain, Env, HexRow, SessionUser } from './lib/types'
import {
  buildSessionClearCookie,
  buildSessionCookie,
  generateOtpCode,
  generateToken,
  getBearerToken,
  getSessionTokenFromRequest,
  keyPrefix,
  nowUnix,
  sha256,
} from './lib/auth'
import { sendOtpEmail } from './lib/email'
import { isValidEmail } from './lib/sanitise'
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

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const STARTER_CREDITS = 500
const OTP_TTL_SECONDS = 10 * 60
const OTP_ATTEMPTS = 5
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const DEFAULT_AGENT_SCOPES = [
  'discover',
  'submit_task',
  'poll_tasks',
  'claim_task',
  'complete_task',
  'rate_task',
] as const

const authStartSchema = z.object({
  email: z.string().min(3).max(200),
})

const authVerifySchema = z.object({
  email: z.string().min(3).max(200),
  code: z.string().min(4).max(12),
})

const createAgentSchema = registerHexSchema.omit({ owner_email: true })

const createAgentKeySchema = z.object({
  name: z.string().min(2).max(64).default('Default agent key').optional(),
  scopes: z.array(z.enum(DEFAULT_AGENT_SCOPES)).min(1).max(DEFAULT_AGENT_SCOPES.length).optional(),
})

const submitTaskRestSchema = submitTaskSchema.extend({
  from_hex: z.string().min(5).max(64),
})

const claimTaskRestSchema = claimTaskSchema.extend({
  hex_id: z.string().min(5).max(64),
})

const completeTaskRestSchema = completeTaskSchema.extend({
  hex_id: z.string().min(5).max(64),
})

const rateTaskRestSchema = rateTaskSchema.extend({
  hex_id: z.string().min(5).max(64),
})

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(data, {
    status,
    headers: {
      ...corsHeaders,
      ...(extraHeaders ?? {}),
    },
  })
}

function parseJsonField<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

function mapHexPublicSummary(hex: HexRow): Record<string, unknown> {
  return {
    hex_id: hex.hex_id,
    agent_name: hex.agent_name,
    description: hex.description,
    domain: hex.domain,
    reputation_score: hex.reputation_score,
    total_tasks: hex.total_tasks,
    price_per_task: hex.price_per_task,
    colour: DOMAIN_COLOURS[hex.domain as Domain] ?? '#6B7280',
    created_at: hex.created_at,
  }
}

function mapHexPublicDetail(hex: HexRow): Record<string, unknown> {
  return {
    hex_id: hex.hex_id,
    agent_name: hex.agent_name,
    description: hex.description,
    domain: hex.domain,
    capabilities: parseJsonField<string[]>(hex.capabilities, []),
    availability: parseJsonField<Record<string, unknown>>(hex.availability, {}),
    reputation_score: hex.reputation_score,
    total_tasks: hex.total_tasks,
    price_per_task: hex.price_per_task,
    created_at: hex.created_at,
  }
}

function normaliseEmail(input: string): string {
  return input.trim().toLowerCase()
}

async function requireSessionUser(request: Request, env: Env): Promise<SessionUser> {
  const token = getSessionTokenFromRequest(request)
  if (!token) throw new HttpError(401, 'Authentication required')
  const tokenHash = await sha256(token)
  const user = await getSessionUserByTokenHash(env.DB, tokenHash, nowUnix())
  if (!user) throw new HttpError(401, 'Invalid or expired session')
  if (!user.email_verified_at) throw new HttpError(403, 'Email not verified')
  return user
}

async function requireOwnedHex(env: Env, user: SessionUser, hexId: string): Promise<HexRow> {
  const hex = await getOwnedHexById(env.DB, hexId, user.email)
  if (!hex) throw new HttpError(403, 'Agent not owned by this user')
  return hex
}

function isProduction(env: Env): boolean {
  return env.ENVIRONMENT === 'production'
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    // ── Health check ──────────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return Response.json(
        { status: 'ok', service: 'hexgrid', version: '0.1.0' },
        { headers: corsHeaders }
      )
    }

    // ── Auth endpoints ─────────────────────────────────────────────────────────
    if (url.pathname === '/auth/start' && request.method === 'POST') {
      try {
        const body = authStartSchema.parse(await request.json())
        const email = normaliseEmail(body.email)
        if (!isValidEmail(email)) {
          throw new HttpError(400, 'Invalid email')
        }

        const now = nowUnix()
        let user = await getUserByEmail(env.DB, email)
        if (!user) {
          const userId = crypto.randomUUID()
          await createUser(env.DB, userId, email, now)
          user = await getUserByEmail(env.DB, email)
        }

        if (!user) throw new Error('Failed to create user')

        const code = generateOtpCode(6)
        const codeHash = await sha256(code)
        await upsertAuthCode(env.DB, email, codeHash, now + OTP_TTL_SECONDS, OTP_ATTEMPTS, now)

        const delivery = await sendOtpEmail(env, email, code)
        if (delivery === 'skipped' && isProduction(env)) {
          throw new HttpError(500, 'Email service not configured')
        }

        return jsonResponse({
          ok: true,
          expires_in_seconds: OTP_TTL_SECONDS,
          delivery,
          ...(delivery === 'skipped' ? { dev_code: code } : {}),
        })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/auth/verify' && request.method === 'POST') {
      try {
        const body = authVerifySchema.parse(await request.json())
        const email = normaliseEmail(body.email)
        const code = body.code.trim()
        const now = nowUnix()

        const authCode = await getAuthCodeByEmail(env.DB, email)
        if (!authCode) throw new HttpError(400, 'No verification code found for this email')
        if (authCode.expires_at < now) throw new HttpError(400, 'Verification code expired')
        if (authCode.attempts_left <= 0) throw new HttpError(429, 'Too many attempts. Request a new code.')

        const codeHash = await sha256(code)
        if (codeHash !== authCode.code_hash) {
          await decrementAuthCodeAttempts(env.DB, email)
          throw new HttpError(401, 'Invalid verification code')
        }

        await deleteAuthCode(env.DB, email)

        let user = await getUserByEmail(env.DB, email)
        if (!user) {
          const userId = crypto.randomUUID()
          await createUser(env.DB, userId, email, now)
          user = await getUserByEmail(env.DB, email)
        }
        if (!user) throw new Error('Failed to create user')

        await markUserEmailVerified(env.DB, user.user_id, now)
        await ensureCreditsAccount(env.DB, email)

        if (!user.starter_credits_granted_at) {
          await creditCredits(env.DB, email, STARTER_CREDITS, now)
          await insertCreditsLedgerEntry(env.DB, {
            entry_id: crypto.randomUUID(),
            account_id: email,
            delta: STARTER_CREDITS,
            reason: 'signup_bonus',
            task_id: null,
            metadata: JSON.stringify({ source: 'starter_grant' }),
            created_at: now,
          })
          await markStarterCreditsGranted(env.DB, user.user_id, now)
        }

        const token = generateToken(32)
        const tokenHash = await sha256(token)
        await createSession(
          env.DB,
          crypto.randomUUID(),
          user.user_id,
          tokenHash,
          now + SESSION_TTL_SECONDS,
          now,
        )

        const cookie = buildSessionCookie(token, isProduction(env), SESSION_TTL_SECONDS)
        return jsonResponse(
          {
            ok: true,
            user: {
              user_id: user.user_id,
              email,
            },
          },
          200,
          { 'Set-Cookie': cookie },
        )
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      try {
        const token = getSessionTokenFromRequest(request)
        if (token) {
          const tokenHash = await sha256(token)
          await revokeSessionByTokenHash(env.DB, tokenHash, nowUnix())
        }
        const clearCookie = buildSessionClearCookie(isProduction(env))
        return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearCookie })
      } catch (err) {
        return jsonResponse({ error: errorMessage(err) }, 400)
      }
    }

    // ── REST API for web frontend ─────────────────────────────────────────────

    // GET /api/me — session profile
    if (url.pathname === '/api/me' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        return jsonResponse({
          user_id: user.user_id,
          email: user.email,
          email_verified_at: user.email_verified_at,
        })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 401
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // GET /api/hexes — all registered hexes (for map)
    if (url.pathname === '/api/hexes' && request.method === 'GET') {
      try {
        const hexes = await getAllHexes(env.DB)
        const data = hexes.map(mapHexPublicSummary)
        return Response.json(data, { headers: corsHeaders })
      } catch (err) {
        return Response.json({ error: errorMessage(err) }, { status: 500, headers: corsHeaders })
      }
    }

    // GET /api/hexes/:id — single hex detail
    if (url.pathname.startsWith('/api/hexes/') && request.method === 'GET') {
      const hexId = url.pathname.replace('/api/hexes/', '')
      try {
        const hex = await getHexById(env.DB, hexId)
        if (!hex) return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders })
        return Response.json(mapHexPublicDetail(hex), { headers: corsHeaders })
      } catch (err) {
        return Response.json({ error: errorMessage(err) }, { status: 500, headers: corsHeaders })
      }
    }

    // POST /api/register — register a new hex (called from web form)
    if (url.pathname === '/api/register' && request.method === 'POST') {
      try {
        const body = await request.json()
        const parsed = registerHexSchema.parse(body)
        const result = await registerHex(parsed, env)
        return Response.json(result, { headers: corsHeaders })
      } catch (err) {
        return Response.json({ error: errorMessage(err) }, { status: 400, headers: corsHeaders })
      }
    }

    // POST /api/agents — authenticated agent registration (owner email from session)
    if (url.pathname === '/api/agents' && request.method === 'POST') {
      try {
        const user = await requireSessionUser(request, env)
        const body = await request.json()
        const parsed = createAgentSchema.parse(body)
        const result = await registerHex({
          ...parsed,
          owner_email: user.email,
        }, env)
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // GET /api/my/agents — list agents owned by authenticated user
    if (url.pathname === '/api/my/agents' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        const hexes = await getHexesByOwnerEmail(env.DB, user.email)
        const result = hexes.map(hex => ({
          ...mapHexPublicDetail(hex),
          colour: DOMAIN_COLOURS[hex.domain as Domain] ?? '#6B7280',
        }))
        return jsonResponse({ agents: result, total: result.length })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // GET /api/my/credits — account balance + ledger
    if (url.pathname === '/api/my/credits' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        await ensureCreditsAccount(env.DB, user.email)
        const credits = await getCredits(env.DB, user.email)
        const ledger = await getCreditsLedgerForAccount(env.DB, user.email, 50)
        return jsonResponse({
          account_id: user.email,
          balance: credits?.balance ?? 0,
          total_earned: credits?.total_earned ?? 0,
          total_spent: credits?.total_spent ?? 0,
          ledger,
        })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // /api/agents/:hexId/keys[/:keyId/revoke]
    if (url.pathname.startsWith('/api/agents/') && url.pathname.includes('/keys')) {
      const segments = url.pathname.split('/').filter(Boolean)
      // Expected:
      // /api/agents/:hexId/keys
      // /api/agents/:hexId/keys/:keyId/revoke
      if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'agents' && segments[3] === 'keys') {
        const hexId = decodeURIComponent(segments[2] ?? '')
        try {
          const user = await requireSessionUser(request, env)
          await requireOwnedHex(env, user, hexId)

          if (segments.length === 4 && request.method === 'GET') {
            const keys = await listAgentApiKeysForHex(env.DB, hexId, user.user_id)
            return jsonResponse({
              keys: keys.map(k => ({
                key_id: k.key_id,
                key_prefix: k.key_prefix,
                name: k.name,
                scopes: parseJsonField<string[]>(k.scopes, []),
                created_at: k.created_at,
                last_used_at: k.last_used_at,
                revoked_at: k.revoked_at,
              })),
            })
          }

          if (segments.length === 4 && request.method === 'POST') {
            const body = createAgentKeySchema.parse(await request.json())
            const scopes = body.scopes ?? [...DEFAULT_AGENT_SCOPES]
            const now = nowUnix()
            const plaintextKey = `hgk_live_${generateToken(24)}`
            const keyHash = await sha256(plaintextKey)
            const keyId = crypto.randomUUID()

            await insertAgentApiKey(env.DB, {
              key_id: keyId,
              user_id: user.user_id,
              hex_id: hexId,
              key_hash: keyHash,
              key_prefix: keyPrefix(plaintextKey),
              name: body.name ?? 'Default agent key',
              scopes: JSON.stringify(scopes),
              created_at: now,
            })

            return jsonResponse({
              key_id: keyId,
              key: plaintextKey,
              key_prefix: keyPrefix(plaintextKey),
              name: body.name ?? 'Default agent key',
              scopes,
              created_at: now,
            })
          }

          if (segments.length === 6 && request.method === 'POST' && segments[5] === 'revoke') {
            const keyId = decodeURIComponent(segments[4] ?? '')
            const ok = await revokeAgentApiKey(env.DB, keyId, hexId, user.user_id, nowUnix())
            if (!ok) throw new HttpError(404, 'Key not found or already revoked')
            return jsonResponse({ ok: true, key_id: keyId })
          }

          return jsonResponse({ error: 'Not found' }, 404)
        } catch (err) {
          const status = err instanceof HttpError ? err.status : 400
          return jsonResponse({ error: errorMessage(err) }, status)
        }
      }
    }

    // POST /api/discover — discover agents
    if (url.pathname === '/api/discover' && request.method === 'POST') {
      try {
        const body = await request.json()
        const parsed = discoverAgentsSchema.parse(body)
        const result = await discoverAgents(parsed, env)
        return Response.json(result, { headers: corsHeaders })
      } catch (err) {
        return Response.json({ error: errorMessage(err) }, { status: 400, headers: corsHeaders })
      }
    }

    // REST wrappers for task lifecycle (session-authenticated)
    if (url.pathname === '/api/tasks/submit' && request.method === 'POST') {
      try {
        const user = await requireSessionUser(request, env)
        const body = submitTaskRestSchema.parse(await request.json())
        await requireOwnedHex(env, user, body.from_hex)
        const result = await submitTask({
          to_hex: body.to_hex,
          task_description: body.task_description,
          max_credits: body.max_credits,
        }, env, {
          key_id: 'session',
          user_id: user.user_id,
          hex_id: body.from_hex,
          scopes: ['submit_task'],
        })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/tasks/inbox' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        const hexId = url.searchParams.get('hex')
        if (!hexId) throw new HttpError(400, 'Missing query param: hex')
        await requireOwnedHex(env, user, hexId)
        const limit = Number(url.searchParams.get('limit') ?? '25')
        const result = await pollTasks({ limit }, env, {
          key_id: 'session',
          user_id: user.user_id,
          hex_id: hexId,
          scopes: ['poll_tasks'],
        })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/tasks/claim' && request.method === 'POST') {
      try {
        const user = await requireSessionUser(request, env)
        const body = claimTaskRestSchema.parse(await request.json())
        await requireOwnedHex(env, user, body.hex_id)
        const result = await claimTask({ task_id: body.task_id }, env, {
          key_id: 'session',
          user_id: user.user_id,
          hex_id: body.hex_id,
          scopes: ['claim_task'],
        })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/tasks/complete' && request.method === 'POST') {
      try {
        const user = await requireSessionUser(request, env)
        const body = completeTaskRestSchema.parse(await request.json())
        await requireOwnedHex(env, user, body.hex_id)
        const result = await completeTask({
          task_id: body.task_id,
          result_summary: body.result_summary,
        }, env, {
          key_id: 'session',
          user_id: user.user_id,
          hex_id: body.hex_id,
          scopes: ['complete_task'],
        })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/tasks/rate' && request.method === 'POST') {
      try {
        const user = await requireSessionUser(request, env)
        const body = rateTaskRestSchema.parse(await request.json())
        await requireOwnedHex(env, user, body.hex_id)
        const result = await rateTask({
          task_id: body.task_id,
          rating: body.rating,
        }, env, {
          key_id: 'session',
          user_id: user.user_id,
          hex_id: body.hex_id,
          scopes: ['rate_task'],
        })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // GET /api/stats — enhanced network stats
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      try {
        const stats = await getEnhancedStats(env.DB)
        return Response.json(stats, { headers: corsHeaders })
      } catch (err) {
        return Response.json({ error: errorMessage(err) }, { status: 500, headers: corsHeaders })
      }
    }

    // GET /api/activity — recent network events
    if (url.pathname === '/api/activity' && request.method === 'GET') {
      try {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '20'), 50)
        const events = await getRecentActivity(env.DB, limit)
        return Response.json({ events }, { headers: corsHeaders })
      } catch (err) {
        return Response.json({ error: errorMessage(err) }, { status: 500, headers: corsHeaders })
      }
    }

    // GET /api/connections — all connections (for spectator map)
    if (url.pathname === '/api/connections' && request.method === 'GET') {
      try {
        const connections = await getAllConnections(env.DB)
        return Response.json(connections, { headers: corsHeaders })
      } catch (err) {
        return Response.json({ error: errorMessage(err) }, { status: 500, headers: corsHeaders })
      }
    }

    // GET /api/connections/:hexId — connections for one agent
    if (url.pathname.startsWith('/api/connections/') && request.method === 'GET') {
      const hexId = url.pathname.replace('/api/connections/', '')
      try {
        const connections = await getConnectionsForHex(env.DB, hexId)
        return Response.json(connections, { headers: corsHeaders })
      } catch (err) {
        return Response.json({ error: errorMessage(err) }, { status: 500, headers: corsHeaders })
      }
    }

    // ── MCP onboard (unauthenticated, rate-limited) ──────────────────────────
    if (url.pathname === '/mcp/onboard' && request.method === 'POST') {
      const ip = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? 'unknown'
      const rateLimitKey = `onboard:${ip}`

      try {
        const { allowed, remaining } = await checkRateLimit(env.DB, rateLimitKey, 3600, 5)
        if (!allowed) {
          return jsonResponse(
            { error: 'Rate limit exceeded. Max 5 onboard attempts per hour.' },
            429,
            { 'X-RateLimit-Remaining': String(remaining) },
          )
        }

        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          sessionIdGenerator: undefined,
        })
        const server = createOnboardMcpServer(env)
        await server.connect(transport)

        // Opportunistic cleanup of stale rate limit rows
        const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200
        cleanupRateLimits(env.DB, twoHoursAgo).catch(() => {})

        return transport.handleRequest(request)
      } catch (err) {
        return jsonResponse({ error: errorMessage(err) }, 500)
      }
    }

    // ── MCP transport (Streamable HTTP) ──────────────────────────────────────
    if (url.pathname === '/mcp') {
      const token = getBearerToken(request)
      if (!token) {
        return jsonResponse({ error: 'Missing bearer token' }, 401)
      }
      const tokenHash = await sha256(token)
      const apiKey = await getAgentApiKeyByHash(env.DB, tokenHash)
      if (!apiKey) {
        return jsonResponse({ error: 'Invalid API key' }, 401)
      }

      const scopes = parseJsonField<string[]>(apiKey.scopes, [])
      await touchAgentApiKeyLastUsed(env.DB, apiKey.key_id, nowUnix())

      // Stateless mode: sessionIdGenerator=undefined disables sessions + SSE.
      // Each POST is independently processed and returns JSON directly.
      // Workers can't hold long-lived SSE connections, so this is required.
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: undefined,
      })
      const server = createMcpServer(env, {
        key_id: apiKey.key_id,
        user_id: apiKey.user_id,
        hex_id: apiKey.hex_id,
        scopes,
      })
      await server.connect(transport)
      return transport.handleRequest(request)
    }

    return Response.json(
      { error: 'Not found', hint: 'Try /health, /api/hexes, or /mcp' },
      { status: 404, headers: corsHeaders }
    )
  }
}
