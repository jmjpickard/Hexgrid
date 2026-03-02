// HexGrid — D1 Query Helpers

import type {
  ActivityEvent,
  AgentApiKeyRow,
  AuthCodeRow,
  CreditsLedgerRow,
  CreditsRow,
  Domain,
  HexRow,
  InteractionRow,
  SessionUser,
  TaskRow,
  UserRow,
} from '../lib/types'

type RunResult = { meta?: { changes?: number } }

function changed(result: RunResult): boolean {
  return (result.meta?.changes ?? 0) > 0
}

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
    .prepare(`
      INSERT OR IGNORE INTO users (user_id, email, created_at)
      VALUES (?, ?, ?)
    `)
    .bind(userId, email, createdAt)
    .run()
}

export async function markUserEmailVerified(db: D1Database, userId: string, verifiedAt: number): Promise<void> {
  await db
    .prepare(`
      UPDATE users
      SET email_verified_at = COALESCE(email_verified_at, ?)
      WHERE user_id = ?
    `)
    .bind(verifiedAt, userId)
    .run()
}

export async function markStarterCreditsGranted(db: D1Database, userId: string, grantedAt: number): Promise<void> {
  await db
    .prepare(`
      UPDATE users
      SET starter_credits_granted_at = COALESCE(starter_credits_granted_at, ?)
      WHERE user_id = ?
    `)
    .bind(grantedAt, userId)
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

export async function createSession(
  db: D1Database,
  sessionId: string,
  userId: string,
  tokenHash: string,
  expiresAt: number,
  createdAt: number,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO sessions (session_id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
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
      SELECT
        u.user_id,
        u.email,
        u.email_verified_at,
        u.starter_credits_granted_at
      FROM sessions s
      INNER JOIN users u ON u.user_id = s.user_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
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

// ─── HEXES ────────────────────────────────────────────────────────────────────

export async function getHexByPublicKey(db: D1Database, publicKey: string): Promise<HexRow | null> {
  const result = await db.prepare('SELECT * FROM hexes WHERE public_key = ?').bind(publicKey).first<HexRow>()
  return result ?? null
}

export async function getHexById(db: D1Database, hexId: string): Promise<HexRow | null> {
  const result = await db.prepare('SELECT * FROM hexes WHERE hex_id = ?').bind(hexId).first<HexRow>()
  return result ?? null
}

export async function getHexesByOwnerEmail(db: D1Database, email: string): Promise<HexRow[]> {
  const result = await db
    .prepare('SELECT * FROM hexes WHERE owner_email = ? AND active = 1 ORDER BY created_at DESC')
    .bind(email)
    .all<HexRow>()
  return result.results
}

export async function getOwnedHexById(db: D1Database, hexId: string, email: string): Promise<HexRow | null> {
  const result = await db
    .prepare('SELECT * FROM hexes WHERE hex_id = ? AND owner_email = ? AND active = 1')
    .bind(hexId, email)
    .first<HexRow>()
  return result ?? null
}

export async function getAllOccupiedHexIds(db: D1Database): Promise<Set<string>> {
  const result = await db.prepare('SELECT hex_id FROM hexes').all<{ hex_id: string }>()
  return new Set(result.results.map(r => r.hex_id))
}

export async function insertHex(
  db: D1Database,
  hex: Omit<HexRow, 'reputation_score' | 'total_tasks' | 'active'>,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO hexes (
        hex_id, public_key, owner_email, agent_name, description,
        domain, capabilities, price_per_task, availability,
        allowed_actions, reputation_score, total_tasks, active, created_at,
        mcp_endpoint, onboarded_via
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 50.0, 0, 1, ?, ?, ?)
    `)
    .bind(
      hex.hex_id,
      hex.public_key,
      hex.owner_email,
      hex.agent_name,
      hex.description,
      hex.domain,
      hex.capabilities,
      hex.price_per_task,
      hex.availability,
      hex.allowed_actions,
      hex.created_at,
      hex.mcp_endpoint,
      hex.onboarded_via,
    )
    .run()
}

export async function discoverHexes(
  db: D1Database,
  domain: Domain,
  maxCredits: number,
  limit = 5,
): Promise<HexRow[]> {
  const result = await db
    .prepare(`
      SELECT * FROM hexes
      WHERE domain = ?
        AND price_per_task <= ?
        AND active = 1
      ORDER BY reputation_score DESC, total_tasks DESC
      LIMIT ?
    `)
    .bind(domain, maxCredits, limit)
    .all<HexRow>()
  return result.results
}

export async function getAllHexes(db: D1Database): Promise<HexRow[]> {
  const result = await db.prepare('SELECT * FROM hexes WHERE active = 1 ORDER BY created_at ASC').all<HexRow>()
  return result.results
}

// ─── API KEYS ─────────────────────────────────────────────────────────────────

export async function insertAgentApiKey(
  db: D1Database,
  key: Omit<AgentApiKeyRow, 'last_used_at' | 'revoked_at'>,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO agent_api_keys (
        key_id, user_id, hex_id, key_hash, key_prefix, name, scopes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(key.key_id, key.user_id, key.hex_id, key.key_hash, key.key_prefix, key.name, key.scopes, key.created_at)
    .run()
}

export async function getAgentApiKeyByHash(db: D1Database, keyHash: string): Promise<AgentApiKeyRow | null> {
  const result = await db
    .prepare('SELECT * FROM agent_api_keys WHERE key_hash = ? AND revoked_at IS NULL')
    .bind(keyHash)
    .first<AgentApiKeyRow>()
  return result ?? null
}

export async function listAgentApiKeysForHex(
  db: D1Database,
  hexId: string,
  userId: string,
): Promise<AgentApiKeyRow[]> {
  const result = await db
    .prepare(`
      SELECT * FROM agent_api_keys
      WHERE hex_id = ? AND user_id = ?
      ORDER BY created_at DESC
    `)
    .bind(hexId, userId)
    .all<AgentApiKeyRow>()
  return result.results
}

export async function touchAgentApiKeyLastUsed(db: D1Database, keyId: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE agent_api_keys SET last_used_at = ? WHERE key_id = ?')
    .bind(now, keyId)
    .run()
}

export async function revokeAgentApiKey(
  db: D1Database,
  keyId: string,
  hexId: string,
  userId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE agent_api_keys
      SET revoked_at = ?
      WHERE key_id = ? AND hex_id = ? AND user_id = ? AND revoked_at IS NULL
    `)
    .bind(now, keyId, hexId, userId)
    .run()
  return changed(result as RunResult)
}

// ─── TASKS + INTERACTIONS ─────────────────────────────────────────────────────

export async function insertTask(db: D1Database, task: TaskRow): Promise<void> {
  await db
    .prepare(`
      INSERT INTO tasks (
        task_id, from_hex, to_hex, description, description_hash,
        credits_escrowed, status, created_at, claimed_at, completed_at, result_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      task.task_id,
      task.from_hex,
      task.to_hex,
      task.description,
      task.description_hash,
      task.credits_escrowed,
      task.status,
      task.created_at,
      task.claimed_at,
      task.completed_at,
      task.result_hash,
    )
    .run()
}

export async function getTaskById(db: D1Database, taskId: string): Promise<TaskRow | null> {
  const result = await db.prepare('SELECT * FROM tasks WHERE task_id = ?').bind(taskId).first<TaskRow>()
  return result ?? null
}

export async function listQueuedTasksForHex(db: D1Database, hexId: string, limit = 25): Promise<TaskRow[]> {
  const result = await db
    .prepare(`
      SELECT * FROM tasks
      WHERE to_hex = ? AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT ?
    `)
    .bind(hexId, limit)
    .all<TaskRow>()
  return result.results
}

export async function claimQueuedTask(db: D1Database, taskId: string, providerHex: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE tasks
      SET status = 'active', claimed_at = ?
      WHERE task_id = ? AND to_hex = ? AND status = 'queued'
    `)
    .bind(now, taskId, providerHex)
    .run()
  return changed(result as RunResult)
}

export async function completeActiveTask(
  db: D1Database,
  taskId: string,
  providerHex: string,
  resultHash: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE tasks
      SET status = 'complete', completed_at = ?, result_hash = ?
      WHERE task_id = ? AND to_hex = ? AND status = 'active'
    `)
    .bind(now, resultHash, taskId, providerHex)
    .run()
  return changed(result as RunResult)
}

export async function insertInteraction(
  db: D1Database,
  interaction: InteractionRow,
): Promise<void> {
  await db
    .prepare(`
      INSERT OR IGNORE INTO interactions (
        interaction_id, task_id, provider_hex, consumer_hex, outcome,
        rating, credits_transferred, platform_fee, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      interaction.interaction_id,
      interaction.task_id,
      interaction.provider_hex,
      interaction.consumer_hex,
      interaction.outcome,
      interaction.rating,
      interaction.credits_transferred,
      interaction.platform_fee,
      interaction.created_at,
    )
    .run()
}

export async function getInteractionByTaskId(db: D1Database, taskId: string): Promise<InteractionRow | null> {
  const result = await db
    .prepare('SELECT * FROM interactions WHERE task_id = ?')
    .bind(taskId)
    .first<InteractionRow>()
  return result ?? null
}

export async function setInteractionRating(
  db: D1Database,
  taskId: string,
  rating: number,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE interactions
      SET rating = ?
      WHERE task_id = ? AND rating IS NULL
    `)
    .bind(rating, taskId)
    .run()
  return changed(result as RunResult)
}

export async function refreshProviderStats(db: D1Database, providerHex: string): Promise<void> {
  const aggregate = await db
    .prepare(`
      SELECT
        COUNT(*) AS total_tasks,
        COUNT(rating) AS rated_tasks,
        AVG(rating) AS avg_rating
      FROM interactions
      WHERE provider_hex = ? AND outcome = 'success'
    `)
    .bind(providerHex)
    .first<{ total_tasks: number; rated_tasks: number; avg_rating: number | null }>()

  const totalTasks = aggregate?.total_tasks ?? 0
  const ratedTasks = aggregate?.rated_tasks ?? 0
  const avgRating = aggregate?.avg_rating ?? null

  const reputation = ratedTasks > 0 && avgRating !== null
    ? Math.round(avgRating * 20 * 10) / 10
    : 50

  await db
    .prepare(`
      UPDATE hexes
      SET total_tasks = ?, reputation_score = ?
      WHERE hex_id = ?
    `)
    .bind(totalTasks, reputation, providerHex)
    .run()
}

// ─── CREDITS + LEDGER ─────────────────────────────────────────────────────────

export async function ensureCreditsAccount(db: D1Database, accountId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare(`
      INSERT OR IGNORE INTO credits (account_id, balance, total_earned, total_spent, created_at, updated_at)
      VALUES (?, 0, 0, 0, ?, ?)
    `)
    .bind(accountId, now, now)
    .run()
}

export async function getCredits(db: D1Database, accountId: string): Promise<CreditsRow | null> {
  const result = await db.prepare('SELECT * FROM credits WHERE account_id = ?').bind(accountId).first<CreditsRow>()
  return result ?? null
}

export async function debitCreditsIfEnough(
  db: D1Database,
  accountId: string,
  amount: number,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE credits
      SET balance = balance - ?, total_spent = total_spent + ?, updated_at = ?
      WHERE account_id = ? AND balance >= ?
    `)
    .bind(amount, amount, now, accountId, amount)
    .run()
  return changed(result as RunResult)
}

export async function creditCredits(
  db: D1Database,
  accountId: string,
  amount: number,
  now: number,
): Promise<void> {
  await db
    .prepare(`
      UPDATE credits
      SET balance = balance + ?, total_earned = total_earned + ?, updated_at = ?
      WHERE account_id = ?
    `)
    .bind(amount, amount, now, accountId)
    .run()
}

export async function insertCreditsLedgerEntry(
  db: D1Database,
  entry: CreditsLedgerRow,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO credits_ledger (
        entry_id, account_id, delta, reason, task_id, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(entry.entry_id, entry.account_id, entry.delta, entry.reason, entry.task_id, entry.metadata, entry.created_at)
    .run()
}

export async function getCreditsLedgerForAccount(
  db: D1Database,
  accountId: string,
  limit = 50,
): Promise<CreditsLedgerRow[]> {
  const result = await db
    .prepare(`
      SELECT * FROM credits_ledger
      WHERE account_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .bind(accountId, limit)
    .all<CreditsLedgerRow>()
  return result.results
}

// ─── RATE LIMITING ───────────────────────────────────────────────────────

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
  await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(olderThan)
    .run()
}

// ─── ACTIVITY FEED ───────────────────────────────────────────────────────

export async function getRecentActivity(db: D1Database, limit = 20): Promise<ActivityEvent[]> {
  const result = await db
    .prepare(`
      SELECT
        'registration' AS type,
        h.agent_name,
        h.domain,
        h.hex_id,
        h.created_at AS timestamp,
        '{}' AS metadata
      FROM hexes h
      WHERE h.active = 1

      UNION ALL

      SELECT
        'task_completed' AS type,
        provider.agent_name,
        provider.domain,
        provider.hex_id,
        i.created_at AS timestamp,
        json_object('rating', i.rating, 'credits', i.credits_transferred) AS metadata
      FROM interactions i
      JOIN hexes provider ON provider.hex_id = i.provider_hex

      ORDER BY timestamp DESC
      LIMIT ?
    `)
    .bind(limit)
    .all<{
      type: string
      agent_name: string
      domain: string
      hex_id: string
      timestamp: number
      metadata: string
    }>()

  return result.results.map(r => ({
    type: r.type as ActivityEvent['type'],
    agent_name: r.agent_name,
    domain: r.domain as ActivityEvent['domain'],
    hex_id: r.hex_id,
    timestamp: r.timestamp,
    metadata: JSON.parse(r.metadata),
  }))
}

// ─── ENHANCED STATS ──────────────────────────────────────────────────────

export async function getEnhancedStats(db: D1Database): Promise<{
  total_agents: number
  total_tasks: number
  avg_reputation: number
  by_domain: Record<string, number>
  credits_24h: number
  tasks_24h: number
}> {
  const hexes = await getAllHexes(db)
  const byDomain = hexes.reduce<Record<string, number>>((acc, h) => {
    acc[h.domain] = (acc[h.domain] ?? 0) + 1
    return acc
  }, {})

  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400

  const credits24h = await db
    .prepare(`
      SELECT COALESCE(SUM(credits_transferred), 0) AS total
      FROM interactions
      WHERE created_at > ?
    `)
    .bind(oneDayAgo)
    .first<{ total: number }>()

  const tasks24h = await db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM tasks
      WHERE created_at > ?
    `)
    .bind(oneDayAgo)
    .first<{ total: number }>()

  return {
    total_agents: hexes.length,
    total_tasks: hexes.reduce((sum, h) => sum + h.total_tasks, 0),
    avg_reputation: hexes.length
      ? Math.round(hexes.reduce((sum, h) => sum + h.reputation_score, 0) / hexes.length * 10) / 10
      : 0,
    by_domain: byDomain,
    credits_24h: credits24h?.total ?? 0,
    tasks_24h: tasks24h?.total ?? 0,
  }
}
