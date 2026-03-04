// HexGrid — Agent-to-agent task tools

import { z } from 'zod'
import type { AgentAuthContext, Env, InteractionRow, TaskRow } from '../lib/types'
import { sanitiseTaskDescription } from '../lib/sanitise'
import { nowUnix, sha256 } from '../lib/auth'
import {
  claimQueuedTask,
  completeActiveTask,
  creditCredits,
  debitCreditsIfEnough,
  ensureCreditsAccount,
  getHexById,
  getInteractionByTaskId,
  getTaskById,
  insertCreditsLedgerEntry,
  insertInteraction,
  insertTask,
  listQueuedTasksForHex,
  refreshProviderStats,
  setInteractionRating,
  updateConnectionRating,
  upsertConnection,
} from '../db/queries'

const PLATFORM_ACCOUNT_ID = 'platform:hexgrid'
const PLATFORM_FEE_BPS = 1200 // 12%

function requireScope(actor: AgentAuthContext, scope: string): void {
  if (!actor.scopes.includes(scope)) {
    throw new Error(`Missing required scope: ${scope}`)
  }
}

export const submitTaskSchema = z.object({
  to_hex: z.string().min(5).max(64),
  task_description: z.string().min(5).max(2000),
  max_credits: z.number().int().min(1).max(10000).optional(),
})

export type SubmitTaskInput = z.infer<typeof submitTaskSchema>

export async function submitTask(
  input: SubmitTaskInput,
  env: Env,
  actor: AgentAuthContext,
): Promise<{
  task_id: string
  status: string
  provider_hex: string
  credits_escrowed: number
}> {
  requireScope(actor, 'submit_task')

  if (input.to_hex === actor.hex_id) {
    throw new Error('You cannot submit a task to your own agent.')
  }

  const requester = await getHexById(env.DB, actor.hex_id)
  if (!requester || requester.active !== 1) {
    throw new Error('Requester agent is not active')
  }

  const provider = await getHexById(env.DB, input.to_hex)
  if (!provider || provider.active !== 1) {
    throw new Error('Provider agent not found')
  }

  const price = provider.price_per_task
  if (input.max_credits !== undefined && price > input.max_credits) {
    throw new Error(`Provider price (${price}) exceeds max_credits (${input.max_credits})`)
  }

  const { clean, flagged, flags, hash } = await sanitiseTaskDescription(input.task_description)
  if (flagged) {
    throw new Error(`Task description contains disallowed patterns: ${flags.join(', ')}`)
  }

  const now = nowUnix()
  const taskId = crypto.randomUUID()
  const requesterAccount = requester.owner_email

  await ensureCreditsAccount(env.DB, requesterAccount)
  const debited = await debitCreditsIfEnough(env.DB, requesterAccount, price, now)
  if (!debited) {
    throw new Error('Insufficient credits for escrow')
  }

  const task: TaskRow = {
    task_id: taskId,
    from_hex: requester.hex_id,
    to_hex: provider.hex_id,
    description: clean,
    description_hash: hash,
    credits_escrowed: price,
    status: 'queued',
    created_at: now,
    claimed_at: null,
    completed_at: null,
    result_hash: null,
  }

  try {
    await insertTask(env.DB, task)
    await insertCreditsLedgerEntry(env.DB, {
      entry_id: crypto.randomUUID(),
      account_id: requesterAccount,
      delta: -price,
      reason: 'task_escrow',
      task_id: taskId,
      metadata: JSON.stringify({
        from_hex: requester.hex_id,
        to_hex: provider.hex_id,
      }),
      created_at: now,
    })
  } catch (err) {
    // Best-effort rollback on failure after debit.
    await creditCredits(env.DB, requesterAccount, price, now)
    await insertCreditsLedgerEntry(env.DB, {
      entry_id: crypto.randomUUID(),
      account_id: requesterAccount,
      delta: price,
      reason: 'manual_adjustment',
      task_id: taskId,
      metadata: JSON.stringify({
        reason: 'rollback_after_task_insert_failure',
      }),
      created_at: now,
    })
    throw err
  }

  return {
    task_id: taskId,
    status: 'queued',
    provider_hex: provider.hex_id,
    credits_escrowed: price,
  }
}

export const pollTasksSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25).optional(),
})

export type PollTasksInput = z.infer<typeof pollTasksSchema>

export async function pollTasks(
  input: PollTasksInput,
  env: Env,
  actor: AgentAuthContext,
): Promise<{
  tasks: Array<{
    task_id: string
    from_hex: string
    description: string
    credits_escrowed: number
    created_at: number
  }>
  total: number
}> {
  requireScope(actor, 'poll_tasks')
  const queued = await listQueuedTasksForHex(env.DB, actor.hex_id, input.limit ?? 25)
  return {
    tasks: queued.map(t => ({
      task_id: t.task_id,
      from_hex: t.from_hex,
      description: t.description,
      credits_escrowed: t.credits_escrowed,
      created_at: t.created_at,
    })),
    total: queued.length,
  }
}

export const claimTaskSchema = z.object({
  task_id: z.string().min(10).max(128),
})

export type ClaimTaskInput = z.infer<typeof claimTaskSchema>

export async function claimTask(
  input: ClaimTaskInput,
  env: Env,
  actor: AgentAuthContext,
): Promise<{ task_id: string; status: string; claimed_at: number }> {
  requireScope(actor, 'claim_task')

  const now = nowUnix()
  const claimed = await claimQueuedTask(env.DB, input.task_id, actor.hex_id, now)
  if (!claimed) {
    const task = await getTaskById(env.DB, input.task_id)
    if (!task) throw new Error('Task not found')
    if (task.to_hex !== actor.hex_id) throw new Error('Task is not assigned to this agent')
    throw new Error(`Task cannot be claimed from status: ${task.status}`)
  }

  return {
    task_id: input.task_id,
    status: 'active',
    claimed_at: now,
  }
}

export const completeTaskSchema = z.object({
  task_id: z.string().min(10).max(128),
  result_summary: z.string().min(5).max(5000),
})

export type CompleteTaskInput = z.infer<typeof completeTaskSchema>

export async function completeTask(
  input: CompleteTaskInput,
  env: Env,
  actor: AgentAuthContext,
): Promise<{
  task_id: string
  status: string
  provider_received: number
  platform_fee: number
}> {
  requireScope(actor, 'complete_task')

  const task = await getTaskById(env.DB, input.task_id)
  if (!task) throw new Error('Task not found')
  if (task.to_hex !== actor.hex_id) throw new Error('Task is not assigned to this agent')

  const provider = await getHexById(env.DB, task.to_hex)
  const requester = await getHexById(env.DB, task.from_hex)
  if (!provider || !requester) {
    throw new Error('Invalid task participants')
  }

  const now = nowUnix()
  const resultHash = await sha256(input.result_summary)
  const completed = await completeActiveTask(env.DB, input.task_id, actor.hex_id, resultHash, now)
  if (!completed) {
    throw new Error(`Task cannot be completed from status: ${task.status}`)
  }

  const fee = Math.floor((task.credits_escrowed * PLATFORM_FEE_BPS) / 10000)
  const providerReceived = task.credits_escrowed - fee

  await ensureCreditsAccount(env.DB, provider.owner_email)
  await ensureCreditsAccount(env.DB, PLATFORM_ACCOUNT_ID)
  await creditCredits(env.DB, provider.owner_email, providerReceived, now)
  if (fee > 0) {
    await creditCredits(env.DB, PLATFORM_ACCOUNT_ID, fee, now)
  }

  const interaction: InteractionRow = {
    interaction_id: crypto.randomUUID(),
    task_id: task.task_id,
    provider_hex: task.to_hex,
    consumer_hex: task.from_hex,
    outcome: 'success',
    rating: null,
    credits_transferred: providerReceived,
    platform_fee: fee,
    created_at: now,
  }
  await insertInteraction(env.DB, interaction)
  await upsertConnection(env.DB, task.from_hex, task.to_hex, now)

  await insertCreditsLedgerEntry(env.DB, {
    entry_id: crypto.randomUUID(),
    account_id: provider.owner_email,
    delta: providerReceived,
    reason: 'task_payout',
    task_id: task.task_id,
    metadata: JSON.stringify({ from_hex: task.from_hex, to_hex: task.to_hex }),
    created_at: now,
  })

  if (fee > 0) {
    await insertCreditsLedgerEntry(env.DB, {
      entry_id: crypto.randomUUID(),
      account_id: PLATFORM_ACCOUNT_ID,
      delta: fee,
      reason: 'task_fee',
      task_id: task.task_id,
      metadata: JSON.stringify({ from_hex: task.from_hex, to_hex: task.to_hex }),
      created_at: now,
    })
  }

  await refreshProviderStats(env.DB, task.to_hex)

  return {
    task_id: task.task_id,
    status: 'complete',
    provider_received: providerReceived,
    platform_fee: fee,
  }
}

export const rateTaskSchema = z.object({
  task_id: z.string().min(10).max(128),
  rating: z.number().int().min(1).max(5),
})

export type RateTaskInput = z.infer<typeof rateTaskSchema>

export async function rateTask(
  input: RateTaskInput,
  env: Env,
  actor: AgentAuthContext,
): Promise<{
  task_id: string
  rating: number
  provider_hex: string
  reputation_score: number
}> {
  requireScope(actor, 'rate_task')

  const task = await getTaskById(env.DB, input.task_id)
  if (!task) throw new Error('Task not found')
  if (task.from_hex !== actor.hex_id) throw new Error('Only the requester can rate this task')
  if (task.status !== 'complete') throw new Error('Task must be complete before rating')

  const interaction = await getInteractionByTaskId(env.DB, input.task_id)
  if (!interaction) throw new Error('No interaction found for task')

  const updated = await setInteractionRating(env.DB, task.task_id, input.rating)
  if (!updated) throw new Error('Task has already been rated')

  await updateConnectionRating(env.DB, task.from_hex, task.to_hex, input.rating)
  await refreshProviderStats(env.DB, interaction.provider_hex)
  const provider = await getHexById(env.DB, interaction.provider_hex)
  if (!provider) throw new Error('Provider not found')

  return {
    task_id: task.task_id,
    rating: input.rating,
    provider_hex: interaction.provider_hex,
    reputation_score: provider.reputation_score,
  }
}

