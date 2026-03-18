// HexGrid — Cloudflare Worker Entry Point (Orchestration Platform)

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import {
  approveDeviceAuthRequest,
  consumeDeviceAuthRequest,
  createCliToken,
  createDeviceAuthRequest,
  createUser,
  createWebSession,
  decrementAuthCodeAttempts,
  deleteAuthCode,
  getAccountStats,
  getAuthCodeByEmail,
  getDeviceAuthRequestByDeviceCode,
  getDeviceAuthRequestByUserCode,
  getConnectionsForAccount,
  getRecentMessages,
  getSessionUserByCliTokenHash,
  getSessionUserByTokenHash,
  getUserByAccountApiKeyHash,
  getUserByEmail,
  markUserEmailVerified,
  revokeCliTokenByHash,
  revokeSessionByTokenHash,
  setAccountApiKey,
  touchCliToken,
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
import {
  connectSession,
  connectSessionSchema,
  disconnect,
  disconnectSchema,
  heartbeat,
  heartbeatSchema,
  listSessions,
  listSessionsForDashboard,
} from './tools/session'
import {
  askAgent,
  askAgentSchema,
  askByCapability,
  askByCapabilitySchema,
  checkMessages,
  checkMessagesSchema,
  getResponse,
  getResponseSchema,
  pollByCapability,
  pollByCapabilitySchema,
  respond,
  respondSchema,
} from './tools/messaging'
import {
  searchKnowledge,
  searchKnowledgeSchema,
  writeKnowledge,
  writeKnowledgeSchema,
} from './tools/knowledge'

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

const OTP_TTL_SECONDS = 10 * 60
const OTP_ATTEMPTS = 5
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const DEVICE_CODE_TTL_SECONDS = 10 * 60
const DEVICE_POLL_INTERVAL_SECONDS = 3
const CLI_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90

const authStartSchema = z.object({
  email: z.string().min(3).max(200),
})

const authVerifySchema = z.object({
  email: z.string().min(3).max(200),
  code: z.string().min(4).max(12),
})

const deviceAuthStartSchema = z.object({
  client_name: z.string().min(1).max(100).optional(),
})

const deviceAuthApproveSchema = z.object({
  user_code: z.string().min(4).max(20),
})

const deviceAuthPollSchema = z.object({
  device_code: z.string().min(10).max(300),
})

function normaliseEmail(input: string): string {
  return input.trim().toLowerCase()
}

function normaliseUserCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function generateUserCode(length = 8): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
}

function allowedOrigins(env: Env): string[] {
  const origins = new Set<string>()

  if (env.APP_URL) origins.add(env.APP_URL)
  origins.add('http://localhost:3000')
  origins.add('http://127.0.0.1:3000')

  return [...origins]
}

function buildCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin')
  const allowed = allowedOrigins(env)
  const defaultOrigin = env.APP_URL ?? 'http://localhost:3000'
  const allowOrigin = origin && allowed.includes(origin) ? origin : defaultOrigin

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  }
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

async function requireCliUser(
  request: Request,
  env: Env,
  touchUsage = true,
): Promise<{ user: SessionUser; tokenHash: string }> {
  const token = getBearerToken(request)
  if (!token) throw new HttpError(401, 'Missing bearer token')

  const tokenHash = await sha256(token)
  const user = await getSessionUserByCliTokenHash(env.DB, tokenHash, nowUnix())
  if (!user) throw new HttpError(401, 'Invalid or expired CLI token')
  if (!user.email_verified_at) throw new HttpError(403, 'Email not verified')

  if (touchUsage) {
    await touchCliToken(env.DB, tokenHash, nowUnix())
  }

  return { user, tokenHash }
}

function isProduction(env: Env): boolean {
  return env.ENVIRONMENT === 'production'
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const corsHeaders = buildCorsHeaders(request, env)
    const jsonResponse = (data: unknown, status = 200, extraHeaders?: Record<string, string>): Response =>
      Response.json(data, {
        status,
        headers: { ...corsHeaders, ...(extraHeaders ?? {}) },
      })

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

    if (url.pathname === '/auth/device/start' && request.method === 'POST') {
      try {
        const raw = await request.text()
        const body = deviceAuthStartSchema.parse(raw ? JSON.parse(raw) : {})
        const now = nowUnix()

        let attempts = 0
        let deviceCode = ''
        let userCode = ''

        while (attempts < 5) {
          attempts += 1
          deviceCode = `hgd_${generateToken(24)}`
          userCode = generateUserCode(8)

          try {
            await createDeviceAuthRequest(env.DB, {
              device_code: deviceCode,
              user_code: userCode,
              user_id: null,
              client_name: body.client_name ?? null,
              status: 'pending',
              created_at: now,
              expires_at: now + DEVICE_CODE_TTL_SECONDS,
              approved_at: null,
              consumed_at: null,
            })
            break
          } catch (err) {
            if (attempts >= 5) throw err
          }
        }

        if (!deviceCode || !userCode) throw new Error('Failed to create device auth request')

        const appUrl = (env.APP_URL ?? 'https://hexgrid.app').replace(/\/+$/, '')
        const verificationUri = `${appUrl}/device`

        return jsonResponse({
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: verificationUri,
          verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
          expires_in_seconds: DEVICE_CODE_TTL_SECONDS,
          interval_seconds: DEVICE_POLL_INTERVAL_SECONDS,
        })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/auth/device/approve' && request.method === 'POST') {
      try {
        const sessionUser = await requireSessionUser(request, env)
        const body = deviceAuthApproveSchema.parse(await request.json())
        const userCode = normaliseUserCode(body.user_code)
        const now = nowUnix()

        const authRequest = await getDeviceAuthRequestByUserCode(env.DB, userCode)
        if (!authRequest) throw new HttpError(404, 'Device code not found')
        if (authRequest.expires_at < now) throw new HttpError(400, 'Device code expired')
        if (authRequest.status === 'consumed') throw new HttpError(400, 'Device code already used')

        if (authRequest.status === 'approved') {
          if (authRequest.user_id !== sessionUser.user_id) {
            throw new HttpError(409, 'Device code already approved by another user')
          }
          return jsonResponse({ ok: true, status: 'approved' })
        }

        const approved = await approveDeviceAuthRequest(env.DB, userCode, sessionUser.user_id, now)
        if (!approved) throw new HttpError(400, 'Unable to approve device code')

        return jsonResponse({ ok: true, status: 'approved' })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/auth/device/poll' && request.method === 'POST') {
      try {
        const body = deviceAuthPollSchema.parse(await request.json())
        const now = nowUnix()
        const authRequest = await getDeviceAuthRequestByDeviceCode(env.DB, body.device_code.trim())

        if (!authRequest) throw new HttpError(404, 'Invalid device code')
        if (authRequest.expires_at < now) throw new HttpError(400, 'Device code expired')

        if (authRequest.status === 'pending') {
          return jsonResponse({
            status: 'pending',
            interval_seconds: DEVICE_POLL_INTERVAL_SECONDS,
            expires_in_seconds: Math.max(0, authRequest.expires_at - now),
          })
        }

        if (authRequest.status === 'consumed') {
          throw new HttpError(400, 'Device code already used')
        }

        if (!authRequest.user_id) {
          throw new HttpError(400, 'Approved device code is missing user association')
        }

        const consumed = await consumeDeviceAuthRequest(env.DB, authRequest.device_code, now)
        if (!consumed) {
          throw new HttpError(409, 'Device code could not be consumed')
        }

        const plaintextToken = `hgt_${generateToken(24)}`
        const tokenHash = await sha256(plaintextToken)

        await createCliToken(env.DB, {
          token_id: crypto.randomUUID(),
          user_id: authRequest.user_id,
          token_hash: tokenHash,
          token_prefix: keyPrefix(plaintextToken),
          created_at: now,
          expires_at: now + CLI_TOKEN_TTL_SECONDS,
          last_used_at: null,
          revoked_at: null,
        })

        return jsonResponse({
          access_token: plaintextToken,
          token_type: 'Bearer',
          expires_in_seconds: CLI_TOKEN_TTL_SECONDS,
          account_id: authRequest.user_id,
        })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
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

    // GET /api/sessions — list agent sessions (dashboard: includes disconnected for claimed repos)
    if (url.pathname === '/api/sessions' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        const result = await listSessionsForDashboard(env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    // GET /api/knowledge — browse knowledge store
    if (url.pathname === '/api/knowledge' && request.method === 'GET') {
      try {
        const user = await requireSessionUser(request, env)
        const requestedLimit = Number(url.searchParams.get('limit') ?? '50')
        const tags = (url.searchParams.get('tags') ?? '')
          .split(',')
          .map(tag => tag.trim())
          .filter(Boolean)
        const result = await searchKnowledge({
          query: url.searchParams.get('query') ?? undefined,
          tags: tags.length > 0 ? tags : undefined,
          repo_key: url.searchParams.get('repo_key') ?? undefined,
          kind: url.searchParams.get('kind') ?? undefined,
          status: (url.searchParams.get('status') ?? undefined) as 'candidate' | 'canonical' | 'stale' | 'archived' | undefined,
          limit: Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 50,
        }, env, { account_id: user.user_id })
        return jsonResponse(result)
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

    // ── CLI API (Bearer token auth via /auth/device/* flow) ──────────────────
    if (url.pathname === '/api/cli/me' && request.method === 'GET') {
      try {
        const { user } = await requireCliUser(request, env)
        return jsonResponse({ user_id: user.user_id, email: user.email })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 401
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/connect' && request.method === 'POST') {
      try {
        const { user } = await requireCliUser(request, env)
        const body = connectSessionSchema.parse(await request.json())
        const result = await connectSession(body, env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/sessions' && request.method === 'GET') {
      try {
        const { user } = await requireCliUser(request, env)
        const result = await listSessions(env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/ask' && request.method === 'POST') {
      try {
        const { user } = await requireCliUser(request, env)
        const raw = await request.json()
        // Route to capability-based ask if capability field is present
        if (raw && typeof raw === 'object' && 'capability' in raw) {
          const body = askByCapabilitySchema.parse(raw)
          const result = await askByCapability(body, env, { account_id: user.user_id })
          return jsonResponse(result)
        }
        const body = askAgentSchema.parse(raw)
        const result = await askAgent(body, env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/poll' && request.method === 'POST') {
      try {
        const { user } = await requireCliUser(request, env)
        const body = pollByCapabilitySchema.parse(await request.json())
        const result = await pollByCapability(body, env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/register' && request.method === 'POST') {
      try {
        const { user } = await requireCliUser(request, env)
        const body = connectSessionSchema.parse(await request.json())
        const result = await connectSession({ ...body, is_listener: true }, env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/knowledge' && request.method === 'POST') {
      try {
        const { user } = await requireCliUser(request, env)
        const body = writeKnowledgeSchema.parse(await request.json())
        const result = await writeKnowledge(body, env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/knowledge/search' && request.method === 'POST') {
      try {
        const { user } = await requireCliUser(request, env)
        const body = searchKnowledgeSchema.parse(await request.json())
        const result = await searchKnowledge(body, env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/inbox' && request.method === 'POST') {
      try {
        const { user } = await requireCliUser(request, env)
        const body = checkMessagesSchema.parse(await request.json())
        const result = await checkMessages(body, env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/reply' && request.method === 'POST') {
      try {
        const { user } = await requireCliUser(request, env)
        const body = respondSchema.parse(await request.json())
        const result = await respond(body, env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/response' && request.method === 'POST') {
      try {
        const { user } = await requireCliUser(request, env)
        const body = getResponseSchema.parse(await request.json())
        const result = await getResponse(body, env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/heartbeat' && request.method === 'POST') {
      try {
        const { user } = await requireCliUser(request, env)
        const body = heartbeatSchema.parse(await request.json())
        const result = await heartbeat(body, env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/disconnect' && request.method === 'POST') {
      try {
        const { user } = await requireCliUser(request, env)
        const body = disconnectSchema.parse(await request.json())
        const result = await disconnect(body, env, { account_id: user.user_id })
        return jsonResponse(result)
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 400
        return jsonResponse({ error: errorMessage(err) }, status)
      }
    }

    if (url.pathname === '/api/cli/logout' && request.method === 'POST') {
      try {
        const { tokenHash } = await requireCliUser(request, env, false)
        await revokeCliTokenByHash(env.DB, tokenHash, nowUnix())
        return jsonResponse({ ok: true })
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 401
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
      const now = nowUnix()

      let accountId: string | null = null

      // Primary mode: long-lived account API key.
      const apiKeyUser = await getUserByAccountApiKeyHash(env.DB, tokenHash)
      if (apiKeyUser) {
        accountId = apiKeyUser.user_id
      } else {
        // Fallback mode: CLI device-flow token (used by `hexgrid run` setup path).
        const cliUser = await getSessionUserByCliTokenHash(env.DB, tokenHash, now)
        if (!cliUser) {
          return jsonResponse({ error: 'Invalid API key or CLI token' }, 401)
        }
        accountId = cliUser.user_id
        await touchCliToken(env.DB, tokenHash, now)
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        sessionIdGenerator: undefined,
      })
      const server = createMcpServer(env, { account_id: accountId })
      await server.connect(transport)
      return transport.handleRequest(request)
    }

    return jsonResponse(
      { error: 'Not found', hint: 'Try /health, /api/stats, or /mcp' },
      404,
    )
  },
}
