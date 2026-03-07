// HexGrid — Cloudflare Worker Entry Point (Orchestration Platform)

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import {
  createUser,
  createWebSession,
  decrementAuthCodeAttempts,
  deleteAuthCode,
  getAccountStats,
  getAuthCodeByEmail,
  getConnectionsForAccount,
  getRecentMessages,
  getSessionUserByTokenHash,
  getUserByAccountApiKeyHash,
  getUserByEmail,
  listAllSessions,
  listKnowledge,
  markUserEmailVerified,
  revokeSessionByTokenHash,
  setAccountApiKey,
  upsertAuthCode,
} from './db/queries'
import { createMcpServer } from './mcp'
import type { Env, SessionUser } from './lib/types'
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

const OTP_TTL_SECONDS = 10 * 60
const OTP_ATTEMPTS = 5
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30

const authStartSchema = z.object({
  email: z.string().min(3).max(200),
})

const authVerifySchema = z.object({
  email: z.string().min(3).max(200),
  code: z.string().min(4).max(12),
})

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(data, {
    status,
    headers: { ...corsHeaders, ...(extraHeaders ?? {}) },
  })
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
      return jsonResponse({ status: 'ok', service: 'hexgrid', version: '0.2.0' })
    }

    // ── Auth endpoints ─────────────────────────────────────────────────────────
    if (url.pathname === '/auth/start' && request.method === 'POST') {
      try {
        const body = authStartSchema.parse(await request.json())
        const email = normaliseEmail(body.email)
        if (!isValidEmail(email)) throw new HttpError(400, 'Invalid email')

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
        if (!authCode) throw new HttpError(400, 'No verification code found')
        if (authCode.expires_at < now) throw new HttpError(400, 'Verification code expired')
        if (authCode.attempts_left <= 0) throw new HttpError(429, 'Too many attempts')

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

        const token = generateToken(32)
        const tokenHash = await sha256(token)
        await createWebSession(env.DB, crypto.randomUUID(), user.user_id, tokenHash, now + SESSION_TTL_SECONDS, now)

        const cookie = buildSessionCookie(token, isProduction(env), SESSION_TTL_SECONDS)
        return jsonResponse(
          { ok: true, user: { user_id: user.user_id, email } },
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

    // ── REST API for web dashboard ──────────────────────────────────────────────

    // GET /api/me
    if (url.pathname === '/api/me' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        return jsonResponse({ user_id: user.user_id, email: user.email })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 401
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // POST /api/account/api-key — generate or rotate account API key
    if (url.pathname === '/api/account/api-key' && request.method === 'POST') {
      try {
        const user = await requireSessionUser(request, env)
        const plaintextKey = `hgk_${generateToken(24)}`
        const keyHash = await sha256(plaintextKey)
        const prefix = keyPrefix(plaintextKey)
        await setAccountApiKey(env.DB, user.user_id, keyHash, prefix)
        return jsonResponse({ key: plaintextKey, key_prefix: prefix })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // GET /api/sessions — list agent sessions
    if (url.pathname === '/api/sessions' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        const sessions = await listAllSessions(env.DB, user.user_id)
        return jsonResponse({ sessions })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // GET /api/knowledge — browse knowledge store
    if (url.pathname === '/api/knowledge' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 100)
        const entries = await listKnowledge(env.DB, user.user_id, limit)
        const mapped = entries.map(e => ({
          ...e,
          tags: JSON.parse(e.tags),
        }))
        return jsonResponse({ entries: mapped })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // GET /api/connections — connection graph
    if (url.pathname === '/api/connections' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        const connections = await getConnectionsForAccount(env.DB, user.user_id)
        return jsonResponse({ connections })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // GET /api/messages — recent messages
    if (url.pathname === '/api/messages' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 100)
        const messages = await getRecentMessages(env.DB, user.user_id, limit)
        return jsonResponse({ messages })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // GET /api/stats — account stats
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        const stats = await getAccountStats(env.DB, user.user_id)
        return jsonResponse(stats)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // ── MCP transport (Streamable HTTP) ──────────────────────────────────────
    if (url.pathname === '/mcp') {
      const token = getBearerToken(request)
      if (!token) {
        return jsonResponse({ error: 'Missing bearer token' }, 401)
      }
      const tokenHash = await sha256(token)
      const user = await getUserByAccountApiKeyHash(env.DB, tokenHash)
      if (!user) {
        return jsonResponse({ error: 'Invalid API key' }, 401)
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: undefined,
      })
      const server = createMcpServer(env, { account_id: user.user_id })
      await server.connect(transport)
      return transport.handleRequest(request)
    }

    return jsonResponse(
      { error: 'Not found', hint: 'Try /health, /api/stats, or /mcp' },
      404,
    )
  },
}
