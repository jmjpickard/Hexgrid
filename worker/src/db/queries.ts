// HexGrid — D1 Query Helpers (Orchestration Platform)

import type {
  AgentSessionRow,
  AuthCodeRow,
  CliTokenRow,
  ConnectionRow,
  DeviceAuthRequestRow,
  KnowledgeRow,
  MessageRow,
  RepoHexClaimRow,
  SessionUser,
  UserRow,
} from '../lib/types'

// ─── USERS + AUTH ─────────────────────────────────────────────────────────────

export async function getUserById(db: D1Database, userId: string): Promise<UserRow | null> {
  const result = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first<UserRow>()
  return result ?? null
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  const result = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>()
  return result ?? null
}

export async function createUser(db: D1Database, userId: string, email: string, createdAt: number): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO users (user_id, email, created_at) VALUES (?, ?, ?)')
    .bind(userId, email, createdAt)
    .run()
}

export async function markUserEmailVerified(db: D1Database, userId: string, verifiedAt: number): Promise<void> {
  await db
    .prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE user_id = ?')
    .bind(verifiedAt, userId)
    .run()
}

export async function upsertAuthCode(
  db: D1Database,
  email: string,
  codeHash: string,
  expiresAt: number,
  attemptsLeft: number,
  createdAt: number,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO auth_codes (email, code_hash, expires_at, attempts_left, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts_left = excluded.attempts_left,
        created_at = excluded.created_at
    `)
    .bind(email, codeHash, expiresAt, attemptsLeft, createdAt)
    .run()
}

export async function getAuthCodeByEmail(db: D1Database, email: string): Promise<AuthCodeRow | null> {
  const result = await db.prepare('SELECT * FROM auth_codes WHERE email = ?').bind(email).first<AuthCodeRow>()
  return result ?? null
}

export async function decrementAuthCodeAttempts(db: D1Database, email: string): Promise<void> {
  await db
    .prepare('UPDATE auth_codes SET attempts_left = attempts_left - 1 WHERE email = ? AND attempts_left > 0')
    .bind(email)
    .run()
}

export async function deleteAuthCode(db: D1Database, email: string): Promise<void> {
  await db.prepare('DELETE FROM auth_codes WHERE email = ?').bind(email).run()
}

export async function createWebSession(
  db: D1Database,
  sessionId: string,
  userId: string,
  tokenHash: string,
  expiresAt: number,
  createdAt: number,
): Promise<void> {
  await db
    .prepare('INSERT INTO sessions (session_id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(sessionId, userId, tokenHash, expiresAt, createdAt)
    .run()
}

export async function getSessionUserByTokenHash(
  db: D1Database,
  tokenHash: string,
  now: number,
): Promise<SessionUser | null> {
  const result = await db
    .prepare(`
      SELECT u.user_id, u.email, u.email_verified_at
      FROM sessions s
      INNER JOIN users u ON u.user_id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
      LIMIT 1
    `)
    .bind(tokenHash, now)
    .first<SessionUser>()
  return result ?? null
}

export async function revokeSessionByTokenHash(db: D1Database, tokenHash: string, revokedAt: number): Promise<void> {
  await db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(revokedAt, tokenHash)
    .run()
}

export async function createDeviceAuthRequest(
  db: D1Database,
  request: DeviceAuthRequestRow,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO device_auth_requests (
        device_code, user_code, user_id, client_name, status,
        created_at, expires_at, approved_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      request.device_code,
      request.user_code,
      request.user_id,
      request.client_name,
      request.status,
      request.created_at,
      request.expires_at,
      request.approved_at,
      request.consumed_at,
    )
    .run()
}

export async function getDeviceAuthRequestByDeviceCode(
  db: D1Database,
  deviceCode: string,
): Promise<DeviceAuthRequestRow | null> {
  const result = await db
    .prepare('SELECT * FROM device_auth_requests WHERE device_code = ?')
    .bind(deviceCode)
    .first<DeviceAuthRequestRow>()
  return result ?? null
}

export async function getDeviceAuthRequestByUserCode(
  db: D1Database,
  userCode: string,
): Promise<DeviceAuthRequestRow | null> {
  const result = await db
    .prepare('SELECT * FROM device_auth_requests WHERE user_code = ?')
    .bind(userCode)
    .first<DeviceAuthRequestRow>()
  return result ?? null
}

export async function approveDeviceAuthRequest(
  db: D1Database,
  userCode: string,
  userId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE device_auth_requests
      SET status = 'approved', user_id = ?, approved_at = ?
      WHERE user_code = ? AND status = 'pending' AND expires_at > ?
    `)
    .bind(userId, now, userCode, now)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

export async function consumeDeviceAuthRequest(
  db: D1Database,
  deviceCode: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE device_auth_requests
      SET status = 'consumed', consumed_at = ?
      WHERE device_code = ? AND status = 'approved' AND expires_at > ?
    `)
    .bind(now, deviceCode, now)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

export async function createCliToken(db: D1Database, token: CliTokenRow): Promise<void> {
  await db
    .prepare(`
      INSERT INTO cli_tokens (
        token_id, user_id, token_hash, token_prefix,
        created_at, expires_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      token.token_id,
      token.user_id,
      token.token_hash,
      token.token_prefix,
      token.created_at,
      token.expires_at,
      token.last_used_at,
      token.revoked_at,
    )
    .run()
}

export async function getSessionUserByCliTokenHash(
  db: D1Database,
  tokenHash: string,
  now: number,
): Promise<SessionUser | null> {
  const result = await db
    .prepare(`
      SELECT u.user_id, u.email, u.email_verified_at
      FROM cli_tokens t
      INNER JOIN users u ON u.user_id = t.user_id
      WHERE t.token_hash = ?
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > ?)
      LIMIT 1
    `)
    .bind(tokenHash, now)
    .first<SessionUser>()
  return result ?? null
}

export async function touchCliToken(db: D1Database, tokenHash: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE cli_tokens SET last_used_at = ? WHERE token_hash = ?')
    .bind(now, tokenHash)
    .run()
}

export async function revokeCliTokenByHash(db: D1Database, tokenHash: string, revokedAt: number): Promise<void> {
  await db
    .prepare('UPDATE cli_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(revokedAt, tokenHash)
    .run()
}

// ─── ACCOUNT API KEYS ────────────────────────────────────────────────────────

export async function getUserByAccountApiKeyHash(db: D1Database, keyHash: string): Promise<UserRow | null> {
  const result = await db
    .prepare('SELECT * FROM users WHERE account_api_key_hash = ?')
    .bind(keyHash)
    .first<UserRow>()
  return result ?? null
}

export async function setAccountApiKey(
  db: D1Database,
  userId: string,
  keyHash: string,
  keyPrefix: string,
): Promise<void> {
  await db
    .prepare('UPDATE users SET account_api_key_hash = ?, account_api_key_prefix = ? WHERE user_id = ?')
    .bind(keyHash, keyPrefix, userId)
    .run()
}

// ─── REPO HEX CLAIMS ─────────────────────────────────────────────────────────

export async function getRepoHexClaim(
  db: D1Database,
  accountId: string,
  repoKey: string,
): Promise<RepoHexClaimRow | null> {
  const result = await db
    .prepare(`
      SELECT *
      FROM repo_hex_claims
      WHERE account_id = ? AND repo_key = ? AND released_at IS NULL
      LIMIT 1
    `)
    .bind(accountId, repoKey)
    .first<RepoHexClaimRow>()
  return result ?? null
}

export async function upsertRepoHexClaim(db: D1Database, claim: RepoHexClaimRow): Promise<void> {
  await db
    .prepare(`
      INSERT INTO repo_hex_claims (
        account_id, repo_key, repo_url, hex_id, created_at, last_seen_at, released_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, repo_key) DO UPDATE SET
        repo_url = excluded.repo_url,
        hex_id = excluded.hex_id,
        last_seen_at = excluded.last_seen_at,
        released_at = NULL
    `)
    .bind(
      claim.account_id,
      claim.repo_key,
      claim.repo_url,
      claim.hex_id,
      claim.created_at,
      claim.last_seen_at,
      claim.released_at,
    )
    .run()
}

export async function getLatestSessionForRepoUrl(
  db: D1Database,
  accountId: string,
  repoUrl: string,
): Promise<{ hex_id: string } | null> {
  const result = await db
    .prepare(`
      SELECT hex_id
      FROM agent_sessions
      WHERE account_id = ? AND repo_url = ?
      ORDER BY connected_at DESC
      LIMIT 1
    `)
    .bind(accountId, repoUrl)
    .first<{ hex_id: string }>()
  return result ?? null
}

export async function getAllReservedHexIds(db: D1Database): Promise<Set<string>> {
  const result = await db
    .prepare(`
      SELECT hex_id FROM agent_sessions WHERE status = 'active'
      UNION
      SELECT hex_id FROM repo_hex_claims WHERE released_at IS NULL
    `)
    .all<{ hex_id: string }>()
  return new Set(result.results.map(row => row.hex_id))
}

// ─── AGENT SESSIONS ──────────────────────────────────────────────────────────

export async function insertAgentSession(
  db: D1Database,
  session: Omit<AgentSessionRow, 'disconnected_at'>,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO agent_sessions (
        session_id, account_id, name, repo_url, description,
        capabilities, hex_id, status, last_heartbeat, connected_at, is_listener
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      session.session_id,
      session.account_id,
      session.name,
      session.repo_url,
      session.description,
      session.capabilities,
      session.hex_id,
      session.status,
      session.last_heartbeat,
      session.connected_at,
      session.is_listener,
    )
    .run()
}

export async function getAgentSession(db: D1Database, sessionId: string): Promise<AgentSessionRow | null> {
  const result = await db
    .prepare('SELECT * FROM agent_sessions WHERE session_id = ?')
    .bind(sessionId)
    .first<AgentSessionRow>()
  return result ?? null
}

export async function listActiveSessions(db: D1Database, accountId: string): Promise<AgentSessionRow[]> {
  const result = await db
    .prepare("SELECT * FROM agent_sessions WHERE account_id = ? AND status = 'active' ORDER BY connected_at DESC")
    .bind(accountId)
    .all<AgentSessionRow>()
  return result.results
}

export async function listAllSessions(db: D1Database, accountId: string): Promise<AgentSessionRow[]> {
  const result = await db
    .prepare('SELECT * FROM agent_sessions WHERE account_id = ? ORDER BY connected_at DESC LIMIT 50')
    .bind(accountId)
    .all<AgentSessionRow>()
  return result.results
}

export async function updateHeartbeat(db: D1Database, sessionId: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE agent_sessions SET last_heartbeat = ? WHERE session_id = ? AND status = 'active'")
    .bind(now, sessionId)
    .run()
}

export async function disconnectSession(db: D1Database, sessionId: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE agent_sessions SET status = 'disconnected', disconnected_at = ? WHERE session_id = ? AND status = 'active'")
    .bind(now, sessionId)
    .run()
}

export async function expireStaleSessions(db: D1Database, staleThreshold: number): Promise<void> {
  await db
    .prepare("UPDATE agent_sessions SET status = 'disconnected', disconnected_at = last_heartbeat WHERE status = 'active' AND last_heartbeat < ?")
    .bind(staleThreshold)
    .run()
}

export async function findActiveSessionsByCapability(
  db: D1Database,
  accountId: string,
  capability: string,
): Promise<AgentSessionRow[]> {
  const like = `%"${capability}"%`
  const result = await db
    .prepare(`
      SELECT * FROM agent_sessions
      WHERE account_id = ? AND capabilities LIKE ? AND status = 'active'
      ORDER BY is_listener DESC, last_heartbeat DESC
    `)
    .bind(accountId, like)
    .all<AgentSessionRow>()
  return result.results
}

export async function getAllOccupiedHexIds(db: D1Database): Promise<Set<string>> {
  const result = await db
    .prepare("SELECT hex_id FROM agent_sessions WHERE status = 'active'")
    .all<{ hex_id: string }>()
  return new Set(result.results.map(r => r.hex_id))
}

// ─── KNOWLEDGE ────────────────────────────────────────────────────────────────

export async function insertKnowledge(db: D1Database, entry: KnowledgeRow): Promise<void> {
  await db
    .prepare(`
      INSERT INTO knowledge (id, account_id, session_id, topic, content, tags, created_at, updated_at, source_message_id, capability)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      entry.id,
      entry.account_id,
      entry.session_id,
      entry.topic,
      entry.content,
      entry.tags,
      entry.created_at,
      entry.updated_at,
      entry.source_message_id,
      entry.capability,
    )
    .run()
}

export async function searchKnowledge(
  db: D1Database,
  accountId: string,
  query?: string,
  tags?: string[],
  limit = 20,
): Promise<Array<KnowledgeRow & { session_name: string }>> {
  let sql = `
    SELECT k.*, s.name AS session_name
    FROM knowledge k
    LEFT JOIN agent_sessions s ON s.session_id = k.session_id
    WHERE k.account_id = ?
  `
  const params: (string | number)[] = [accountId]

  if (query) {
    sql += ' AND (k.topic LIKE ? OR k.content LIKE ?)'
    const like = `%${query}%`
    params.push(like, like)
  }

  if (tags && tags.length > 0) {
    for (const tag of tags) {
      sql += ' AND k.tags LIKE ?'
      params.push(`%"${tag}"%`)
    }
  }

  sql += ' ORDER BY k.updated_at DESC LIMIT ?'
  params.push(limit)

  const stmt = db.prepare(sql)
  const bound = stmt.bind(...params)
  const result = await bound.all<KnowledgeRow & { session_name: string }>()
  return result.results
}

export async function listKnowledge(
  db: D1Database,
  accountId: string,
  limit = 50,
): Promise<Array<KnowledgeRow & { session_name: string }>> {
  const result = await db
    .prepare(`
      SELECT k.*, s.name AS session_name
      FROM knowledge k
      LEFT JOIN agent_sessions s ON s.session_id = k.session_id
      WHERE k.account_id = ?
      ORDER BY k.updated_at DESC
      LIMIT ?
    `)
    .bind(accountId, limit)
    .all<KnowledgeRow & { session_name: string }>()
  return result.results
}

export async function deleteKnowledge(db: D1Database, id: string, accountId: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM knowledge WHERE id = ? AND account_id = ?')
    .bind(id, accountId)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

export async function searchKnowledgeByCapability(
  db: D1Database,
  accountId: string,
  capability: string,
  question: string,
  limit = 3,
): Promise<KnowledgeRow[]> {
  const like = `%${question}%`
  const result = await db
    .prepare(`
      SELECT * FROM knowledge
      WHERE account_id = ? AND capability = ? AND (topic LIKE ? OR content LIKE ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .bind(accountId, capability, like, like, limit)
    .all<KnowledgeRow>()
  return result.results
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────

export async function insertMessage(db: D1Database, msg: MessageRow): Promise<void> {
  await db
    .prepare(`
      INSERT INTO messages (id, account_id, from_session_id, to_session_id, question, answer, status, created_at, answered_at, expires_at, capability, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      msg.id,
      msg.account_id,
      msg.from_session_id,
      msg.to_session_id,
      msg.question,
      msg.answer,
      msg.status,
      msg.created_at,
      msg.answered_at,
      msg.expires_at,
      msg.capability,
      msg.context,
    )
    .run()
}

export async function getPendingMessages(
  db: D1Database,
  toSessionId: string,
): Promise<Array<MessageRow & { from_session_name: string }>> {
  const result = await db
    .prepare(`
      SELECT m.*, s.name AS from_session_name
      FROM messages m
      LEFT JOIN agent_sessions s ON s.session_id = m.from_session_id
      WHERE m.to_session_id = ? AND m.status = 'pending'
      ORDER BY m.created_at ASC
    `)
    .bind(toSessionId)
    .all<MessageRow & { from_session_name: string }>()
  return result.results
}

export async function answerMessage(
  db: D1Database,
  messageId: string,
  toSessionId: string,
  answer: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare("UPDATE messages SET answer = ?, status = 'answered', answered_at = ? WHERE id = ? AND to_session_id = ? AND status = 'pending'")
    .bind(answer, now, messageId, toSessionId)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

export async function getMessageById(db: D1Database, messageId: string): Promise<MessageRow | null> {
  const result = await db
    .prepare('SELECT * FROM messages WHERE id = ?')
    .bind(messageId)
    .first<MessageRow>()
  return result ?? null
}

export async function expireOldMessages(db: D1Database, now: number): Promise<void> {
  await db
    .prepare("UPDATE messages SET status = 'expired' WHERE status = 'pending' AND expires_at < ?")
    .bind(now)
    .run()
}

export async function deleteOldAnsweredMessages(db: D1Database, olderThan: number): Promise<void> {
  await db
    .prepare("DELETE FROM messages WHERE status = 'answered' AND answered_at < ?")
    .bind(olderThan)
    .run()
}

export async function getPendingMessagesByCapability(
  db: D1Database,
  accountId: string,
  sessionId: string,
  capability?: string,
): Promise<Array<MessageRow & { from_session_name: string }>> {
  let sql = `
    SELECT m.*, s.name AS from_session_name
    FROM messages m
    LEFT JOIN agent_sessions s ON s.session_id = m.from_session_id
    WHERE m.to_session_id = ? AND m.account_id = ? AND m.status = 'pending'
  `
  const params: (string | number)[] = [sessionId, accountId]

  if (capability) {
    sql += ' AND m.capability = ?'
    params.push(capability)
  }

  sql += ' ORDER BY m.created_at ASC'

  const stmt = db.prepare(sql)
  const bound = stmt.bind(...params)
  const result = await bound.all<MessageRow & { from_session_name: string }>()
  return result.results
}

export async function expireSiblingCapabilityMessages(
  db: D1Database,
  answeredMessageId: string,
  fromSessionId: string,
  capability: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE messages SET status = 'expired'
      WHERE from_session_id = ? AND capability = ? AND status = 'pending' AND id != ?
    `)
    .bind(fromSessionId, capability, answeredMessageId)
    .run()
}

export async function countPendingMessages(db: D1Database, toSessionId: string): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) AS count FROM messages WHERE to_session_id = ? AND status = 'pending'")
    .bind(toSessionId)
    .first<{ count: number }>()
  return result?.count ?? 0
}

export async function getRecentMessages(
  db: D1Database,
  accountId: string,
  limit = 50,
): Promise<Array<MessageRow & { from_session_name: string; to_session_name: string }>> {
  const result = await db
    .prepare(`
      SELECT m.*,
        sf.name AS from_session_name,
        st.name AS to_session_name
      FROM messages m
      LEFT JOIN agent_sessions sf ON sf.session_id = m.from_session_id
      LEFT JOIN agent_sessions st ON st.session_id = m.to_session_id
      WHERE m.account_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `)
    .bind(accountId, limit)
    .all<MessageRow & { from_session_name: string; to_session_name: string }>()
  return result.results
}

// ─── CONNECTIONS ──────────────────────────────────────────────────────────────

export async function upsertConnection(
  db: D1Database,
  accountId: string,
  sessionAId: string,
  sessionBId: string,
  now: number,
): Promise<void> {
  // Normalize order so (A,B) and (B,A) map to same row
  const [a, b] = sessionAId < sessionBId ? [sessionAId, sessionBId] : [sessionBId, sessionAId]
  await db
    .prepare(`
      INSERT INTO connections (id, account_id, session_a_id, session_b_id, interaction_count, strength, last_interaction)
      VALUES (?, ?, ?, ?, 1, 1, ?)
      ON CONFLICT(account_id, session_a_id, session_b_id) DO UPDATE SET
        interaction_count = connections.interaction_count + 1,
        strength = connections.interaction_count + 1,
        last_interaction = excluded.last_interaction
    `)
    .bind(crypto.randomUUID(), accountId, a, b, now)
    .run()
}

export async function getConnectionsForAccount(db: D1Database, accountId: string): Promise<ConnectionRow[]> {
  const result = await db
    .prepare('SELECT * FROM connections WHERE account_id = ? ORDER BY strength DESC')
    .bind(accountId)
    .all<ConnectionRow>()
  return result.results
}

// ─── STATS ────────────────────────────────────────────────────────────────────

export async function getAccountStats(db: D1Database, accountId: string): Promise<{
  active_sessions: number
  total_knowledge: number
  total_messages: number
  total_connections: number
}> {
  const [sessions, knowledge, messages, connections] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS c FROM agent_sessions WHERE account_id = ? AND status = 'active'")
      .bind(accountId).first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) AS c FROM knowledge WHERE account_id = ?')
      .bind(accountId).first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) AS c FROM messages WHERE account_id = ?')
      .bind(accountId).first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) AS c FROM connections WHERE account_id = ?')
      .bind(accountId).first<{ c: number }>(),
  ])

  return {
    active_sessions: sessions?.c ?? 0,
    total_knowledge: knowledge?.c ?? 0,
    total_messages: messages?.c ?? 0,
    total_connections: connections?.c ?? 0,
  }
}

// ─── RATE LIMITING ────────────────────────────────────────────────────────────

export async function checkRateLimit(
  db: D1Database,
  key: string,
  windowSeconds: number,
  maxCount: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Math.floor(Date.now() / 1000)
  const windowStart = now - (now % windowSeconds)

  const row = await db
    .prepare('SELECT count FROM rate_limits WHERE key = ? AND window_start = ?')
    .bind(key, windowStart)
    .first<{ count: number }>()

  const current = row?.count ?? 0
  if (current >= maxCount) {
    return { allowed: false, remaining: 0 }
  }

  await db
    .prepare(`
      INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
    `)
    .bind(key, windowStart)
    .run()

  return { allowed: true, remaining: maxCount - current - 1 }
}

export async function cleanupRateLimits(db: D1Database, olderThan: number): Promise<void> {
  await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(olderThan).run()
}
