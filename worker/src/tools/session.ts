// HexGrid — Session tools (connect, heartbeat, list, disconnect)

import { z } from 'zod'
import type { AccountAuthContext, ConnectSessionOutput, Env, HeartbeatOutput, ListSessionsOutput } from '../lib/types'
import { nowUnix } from '../lib/auth'
import {
  countPendingMessages,
  disconnectSession,
  expireStaleSessions,
  getAllReservedHexIds,
  getAgentSession,
  getLatestSessionForRepoUrl,
  getRepoHexClaim,
  insertAgentSession,
  listActiveSessions,
  upsertRepoHexClaim,
  updateHeartbeat,
} from '../db/queries'
import { assignHex, getHexCentre } from '../lib/h3'
import { normaliseRepoUrl } from '../lib/repo'
import { sanitiseAgentName, sanitiseDescription, sanitiseCapabilities } from '../lib/sanitise'

const STALE_THRESHOLD_SECONDS = 600 // 10 minutes

export const connectSessionSchema = z.object({
  name: z.string().min(1).max(50),
  repo_url: z.string().max(500).optional(),
  description: z.string().max(200).optional(),
  capabilities: z.array(z.string().max(50)).max(20).optional(),
  is_listener: z.boolean().optional(),
})

export async function connectSession(
  input: z.infer<typeof connectSessionSchema>,
  env: Env,
  account: AccountAuthContext,
): Promise<ConnectSessionOutput> {
  const now = nowUnix()

  // Expire stale sessions on connect
  await expireStaleSessions(env.DB, now - STALE_THRESHOLD_SECONDS)

  const name = sanitiseAgentName(input.name)
  const repoUrl = input.repo_url?.trim() ? input.repo_url.trim() : null
  const description = input.description ? sanitiseDescription(input.description) : null
  const capabilities = input.capabilities ? sanitiseCapabilities(input.capabilities) : []
  const repoKey = repoUrl ? normaliseRepoUrl(repoUrl) : ''

  let hexId: string

  if (repoUrl && repoKey) {
    const claim = await getRepoHexClaim(env.DB, account.account_id, repoKey)
    if (claim) {
      hexId = claim.hex_id
      await upsertRepoHexClaim(env.DB, {
        ...claim,
        repo_url: repoUrl,
        last_seen_at: now,
      })
    } else {
      const [reservedHexes, previousSession] = await Promise.all([
        getAllReservedHexIds(env.DB),
        getLatestSessionForRepoUrl(env.DB, account.account_id, repoUrl),
      ])
      hexId = previousSession?.hex_id ?? await assignHex('coding', reservedHexes)

      await upsertRepoHexClaim(env.DB, {
        account_id: account.account_id,
        repo_key: repoKey,
        repo_url: repoUrl,
        hex_id: hexId,
        created_at: now,
        last_seen_at: now,
        released_at: null,
      })
    }
  } else {
    const reservedHexes = await getAllReservedHexIds(env.DB)
    hexId = await assignHex('coding', reservedHexes)
  }

  const sessionId = crypto.randomUUID()

  await insertAgentSession(env.DB, {
    session_id: sessionId,
    account_id: account.account_id,
    name,
    repo_url: repoUrl,
    description,
    capabilities: JSON.stringify(capabilities),
    hex_id: hexId,
    status: 'active',
    last_heartbeat: now,
    connected_at: now,
    is_listener: input.is_listener ? 1 : 0,
  })

  const active = await listActiveSessions(env.DB, account.account_id)

  return {
    session_id: sessionId,
    hex_id: hexId,
    active_sessions: active.map(s => ({
      session_id: s.session_id,
      name: s.name,
      hex_id: s.hex_id,
      status: s.status,
    })),
  }
}

export const heartbeatSchema = z.object({
  session_id: z.string().uuid(),
})

export async function heartbeat(
  input: z.infer<typeof heartbeatSchema>,
  env: Env,
  account: AccountAuthContext,
): Promise<HeartbeatOutput> {
  const now = nowUnix()

  // Expire stale sessions on heartbeat
  await expireStaleSessions(env.DB, now - STALE_THRESHOLD_SECONDS)

  const session = await getAgentSession(env.DB, input.session_id)
  if (!session || session.account_id !== account.account_id) {
    throw new Error('Session not found')
  }
  if (session.status !== 'active') {
    throw new Error('Session is not active')
  }

  await updateHeartbeat(env.DB, input.session_id, now)

  const pending = await countPendingMessages(env.DB, input.session_id)

  return { ok: true, pending_messages: pending }
}

export const listSessionsSchema = z.object({})

export async function listSessions(
  env: Env,
  account: AccountAuthContext,
): Promise<ListSessionsOutput> {
  const now = nowUnix()
  await expireStaleSessions(env.DB, now - STALE_THRESHOLD_SECONDS)

  const sessions = await listActiveSessions(env.DB, account.account_id)

  return {
    sessions: sessions.map(s => {
      const [hexCenterLat, hexCenterLng] = getHexCentre(s.hex_id)
      return {
        session_id: s.session_id,
        account_id: s.account_id,
        name: s.name,
        repo_url: s.repo_url,
        description: s.description,
        capabilities: s.capabilities,
        hex_id: s.hex_id,
        status: s.status,
        last_heartbeat: s.last_heartbeat,
        connected_at: s.connected_at,
        disconnected_at: s.disconnected_at,
        hex_center_lat: hexCenterLat,
        hex_center_lng: hexCenterLng,
      }
    }),
  }
}

export const disconnectSchema = z.object({
  session_id: z.string().uuid(),
})

export async function disconnect(
  input: z.infer<typeof disconnectSchema>,
  env: Env,
  account: AccountAuthContext,
): Promise<{ ok: boolean }> {
  const session = await getAgentSession(env.DB, input.session_id)
  if (!session || session.account_id !== account.account_id) {
    throw new Error('Session not found')
  }

  await disconnectSession(env.DB, input.session_id, nowUnix())
  return { ok: true }
}
