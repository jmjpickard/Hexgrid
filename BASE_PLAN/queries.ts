// HexGrid — D1 Query Helpers

import type { D1Database } from '@cloudflare/workers-types'
import type { HexRow, TaskRow, CreditsRow, Domain } from '../lib/types'

// ─── HEXES ────────────────────────────────────────────────────────────────────

export async function getHexByPublicKey(
  db: D1Database,
  publicKey: string
): Promise<HexRow | null> {
  const result = await db
    .prepare('SELECT * FROM hexes WHERE public_key = ?')
    .bind(publicKey)
    .first<HexRow>()
  return result ?? null
}

export async function getHexById(
  db: D1Database,
  hexId: string
): Promise<HexRow | null> {
  const result = await db
    .prepare('SELECT * FROM hexes WHERE hex_id = ?')
    .bind(hexId)
    .first<HexRow>()
  return result ?? null
}

export async function getAllOccupiedHexIds(
  db: D1Database
): Promise<Set<string>> {
  const result = await db
    .prepare('SELECT hex_id FROM hexes')
    .all<{ hex_id: string }>()
  return new Set(result.results.map(r => r.hex_id))
}

export async function insertHex(
  db: D1Database,
  hex: Omit<HexRow, 'reputation_score' | 'total_tasks' | 'active'>
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO hexes (
        hex_id, public_key, owner_email, agent_name, description,
        domain, capabilities, price_per_task, availability,
        allowed_actions, reputation_score, total_tasks, active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 50.0, 0, 1, ?)
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
      hex.created_at
    )
    .run()
}

export async function discoverHexes(
  db: D1Database,
  domain: Domain,
  maxCredits: number,
  limit = 5
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
  const result = await db
    .prepare('SELECT * FROM hexes WHERE active = 1 ORDER BY created_at ASC')
    .all<HexRow>()
  return result.results
}

export async function updateReputationScore(
  db: D1Database,
  hexId: string,
  newScore: number,
  totalTasks: number
): Promise<void> {
  await db
    .prepare(`
      UPDATE hexes 
      SET reputation_score = ?, total_tasks = ?
      WHERE hex_id = ?
    `)
    .bind(newScore, totalTasks, hexId)
    .run()
}

// ─── TASKS ────────────────────────────────────────────────────────────────────

export async function insertTask(
  db: D1Database,
  task: Omit<TaskRow, 'status' | 'claimed_at' | 'completed_at' | 'result_hash'>
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO tasks (
        task_id, from_hex, to_hex, description, description_hash,
        credits_escrowed, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
    `)
    .bind(
      task.task_id,
      task.from_hex,
      task.to_hex,
      task.description,
      task.description_hash,
      task.credits_escrowed,
      task.created_at
    )
    .run()
}

export async function getNextTaskForHex(
  db: D1Database,
  hexId: string
): Promise<TaskRow | null> {
  const result = await db
    .prepare(`
      SELECT * FROM tasks
      WHERE to_hex = ? AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `)
    .bind(hexId)
    .first<TaskRow>()
  return result ?? null
}

export async function claimTask(
  db: D1Database,
  taskId: string
): Promise<void> {
  await db
    .prepare(`
      UPDATE tasks SET status = 'active', claimed_at = ?
      WHERE task_id = ? AND status = 'queued'
    `)
    .bind(Math.floor(Date.now() / 1000), taskId)
    .run()
}

export async function completeTask(
  db: D1Database,
  taskId: string,
  resultHash: string
): Promise<void> {
  await db
    .prepare(`
      UPDATE tasks SET status = 'complete', completed_at = ?, result_hash = ?
      WHERE task_id = ?
    `)
    .bind(Math.floor(Date.now() / 1000), resultHash, taskId)
    .run()
}

// ─── CREDITS ──────────────────────────────────────────────────────────────────

export async function getCredits(
  db: D1Database,
  accountId: string
): Promise<CreditsRow | null> {
  const result = await db
    .prepare('SELECT * FROM credits WHERE account_id = ?')
    .bind(accountId)
    .first<CreditsRow>()
  return result ?? null
}

export async function ensureCreditsAccount(
  db: D1Database,
  accountId: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare(`
      INSERT OR IGNORE INTO credits (account_id, balance, total_earned, total_spent, created_at, updated_at)
      VALUES (?, 0, 0, 0, ?, ?)
    `)
    .bind(accountId, now, now)
    .run()
}

export async function transferCredits(
  db: D1Database,
  fromAccountId: string,
  toAccountId: string,
  amount: number,
  platformFee: number
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const toAmount = amount - platformFee

  // Deduct from consumer
  await db
    .prepare(`
      UPDATE credits 
      SET balance = balance - ?, total_spent = total_spent + ?, updated_at = ?
      WHERE account_id = ?
    `)
    .bind(amount, amount, now, fromAccountId)
    .run()

  // Credit to provider (minus platform fee)
  await db
    .prepare(`
      UPDATE credits 
      SET balance = balance + ?, total_earned = total_earned + ?, updated_at = ?
      WHERE account_id = ?
    `)
    .bind(toAmount, toAmount, now, toAccountId)
    .run()
}
