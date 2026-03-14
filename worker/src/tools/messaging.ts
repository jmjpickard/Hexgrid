// HexGrid — Messaging tools (ask_agent, check_messages, respond, get_response)

import { z } from 'zod'
import type {
  AccountAuthContext,
  AskAgentOutput,
  AskByCapabilityOutput,
  CheckMessagesOutput,
  Env,
  GetResponseOutput,
  PollByCapabilityOutput,
  RespondOutput,
} from '../lib/types'
import { nowUnix } from '../lib/auth'
import {
  answerMessage,
  deleteOldAnsweredMessages,
  expireOldMessages,
  expireSiblingCapabilityMessages,
  findActiveSessionsByCapability,
  getAgentSession,
  getMessageById,
  getPendingMessages,
  getPendingMessagesByCapability,
  insertKnowledge,
  insertMessage,
  searchKnowledgeByCapability,
  upsertConnection,
} from '../db/queries'
import { sanitiseTaskDescription } from '../lib/sanitise'

const MESSAGE_EXPIRY_SECONDS = 30 * 60 // 30 minutes
const ANSWERED_CLEANUP_SECONDS = 60 * 60 // 1 hour after answered

export const askAgentSchema = z.object({
  session_id: z.string().uuid(),
  to_session_id: z.string().uuid(),
  question: z.string().min(1).max(5000),
})

export async function askAgent(
  input: z.infer<typeof askAgentSchema>,
  env: Env,
  account: AccountAuthContext,
): Promise<AskAgentOutput> {
  if (input.session_id === input.to_session_id) {
    throw new Error('Cannot send a message to yourself')
  }

  const [fromSession, toSession] = await Promise.all([
    getAgentSession(env.DB, input.session_id),
    getAgentSession(env.DB, input.to_session_id),
  ])

  if (!fromSession || fromSession.account_id !== account.account_id) {
    throw new Error('Source session not found')
  }
  if (!toSession || toSession.account_id !== account.account_id) {
    throw new Error('Target session not found or not on the same account')
  }

  const { clean, flagged, flags } = await sanitiseTaskDescription(input.question)
  if (flagged) {
    throw new Error(`Question contains disallowed patterns: ${flags.join(', ')}`)
  }

  const now = nowUnix()
  const messageId = crypto.randomUUID()

  await insertMessage(env.DB, {
    id: messageId,
    account_id: account.account_id,
    from_session_id: input.session_id,
    to_session_id: input.to_session_id,
    question: clean,
    answer: null,
    status: 'pending',
    created_at: now,
    answered_at: null,
    expires_at: now + MESSAGE_EXPIRY_SECONDS,
    capability: null,
    context: null,
  })

  // Strengthen connection
  await upsertConnection(env.DB, account.account_id, input.session_id, input.to_session_id, now)

  // Opportunistic cleanup
  expireOldMessages(env.DB, now).catch(() => {})
  deleteOldAnsweredMessages(env.DB, now - ANSWERED_CLEANUP_SECONDS).catch(() => {})

  return {
    message_id: messageId,
    to_session_id: input.to_session_id,
    status: 'pending',
  }
}

// ─── Ask by capability ──────────────────────────────────────────────────────

const MAX_ROUTED_TARGETS = 2

export const askByCapabilitySchema = z.object({
  session_id: z.string().uuid(),
  capability: z.string().min(1).max(100),
  question: z.string().min(1).max(5000),
  context: z.string().max(2000).optional(),
})

export async function askByCapability(
  input: z.infer<typeof askByCapabilitySchema>,
  env: Env,
  account: AccountAuthContext,
): Promise<AskByCapabilityOutput> {
  const fromSession = await getAgentSession(env.DB, input.session_id)
  if (!fromSession || fromSession.account_id !== account.account_id) {
    throw new Error('Source session not found')
  }

  const { clean: cleanQuestion, flagged: qFlagged, flags: qFlags } = await sanitiseTaskDescription(input.question)
  if (qFlagged) {
    throw new Error(`Question contains disallowed patterns: ${qFlags.join(', ')}`)
  }

  let cleanContext: string | null = null
  if (input.context) {
    const { clean, flagged, flags } = await sanitiseTaskDescription(input.context)
    if (flagged) {
      throw new Error(`Context contains disallowed patterns: ${flags.join(', ')}`)
    }
    cleanContext = clean
  }

  // Knowledge-first: check if we already have an answer
  const knowledgeHits = await searchKnowledgeByCapability(
    env.DB,
    account.account_id,
    input.capability,
    input.question,
    3,
  )

  if (knowledgeHits.length > 0) {
    const best = knowledgeHits[0]
    return {
      source: 'knowledge',
      answer: best.content,
      knowledge_id: best.id,
    }
  }

  // Route to live sessions with matching capability
  const targets = await findActiveSessionsByCapability(
    env.DB,
    account.account_id,
    input.capability,
  )

  // Exclude the asking session
  const eligible = targets.filter(s => s.session_id !== input.session_id)
  if (eligible.length === 0) {
    throw new Error(`No active sessions with capability "${input.capability}". Start a listener with \`hexgrid listen --capability ${input.capability}\`.`)
  }

  const now = nowUnix()
  const selected = eligible.slice(0, MAX_ROUTED_TARGETS)
  const messageIds: string[] = []
  const routedTo: string[] = []

  for (const target of selected) {
    const messageId = crypto.randomUUID()
    await insertMessage(env.DB, {
      id: messageId,
      account_id: account.account_id,
      from_session_id: input.session_id,
      to_session_id: target.session_id,
      question: cleanQuestion,
      answer: null,
      status: 'pending',
      created_at: now,
      answered_at: null,
      expires_at: now + MESSAGE_EXPIRY_SECONDS,
      capability: input.capability,
      context: cleanContext,
    })
    await upsertConnection(env.DB, account.account_id, input.session_id, target.session_id, now)
    messageIds.push(messageId)
    routedTo.push(target.session_id)
  }

  // Opportunistic cleanup
  expireOldMessages(env.DB, now).catch(() => {})
  deleteOldAnsweredMessages(env.DB, now - ANSWERED_CLEANUP_SECONDS).catch(() => {})

  return {
    source: 'routed',
    message_ids: messageIds,
    routed_to: routedTo,
  }
}

// ─── Poll by capability (for sidecar/listener) ─────────────────────────────

export const pollByCapabilitySchema = z.object({
  session_id: z.string().uuid(),
  capability: z.string().max(100).optional(),
})

export async function pollByCapability(
  input: z.infer<typeof pollByCapabilitySchema>,
  env: Env,
  account: AccountAuthContext,
): Promise<PollByCapabilityOutput> {
  const session = await getAgentSession(env.DB, input.session_id)
  if (!session || session.account_id !== account.account_id) {
    throw new Error('Session not found')
  }

  const now = nowUnix()
  await expireOldMessages(env.DB, now)

  const pending = await getPendingMessagesByCapability(
    env.DB,
    account.account_id,
    input.session_id,
    input.capability,
  )

  return {
    messages: pending.map(m => ({
      message_id: m.id,
      from_session_id: m.from_session_id,
      from_session_name: m.from_session_name ?? 'unknown',
      question: m.question,
      context: m.context,
      capability: m.capability,
      created_at: m.created_at,
    })),
    total: pending.length,
  }
}

export const checkMessagesSchema = z.object({
  session_id: z.string().uuid(),
})

export async function checkMessages(
  input: z.infer<typeof checkMessagesSchema>,
  env: Env,
  account: AccountAuthContext,
): Promise<CheckMessagesOutput> {
  const session = await getAgentSession(env.DB, input.session_id)
  if (!session || session.account_id !== account.account_id) {
    throw new Error('Session not found')
  }

  // Expire old messages on read
  const now = nowUnix()
  await expireOldMessages(env.DB, now)

  const pending = await getPendingMessages(env.DB, input.session_id)

  return {
    messages: pending.map(m => ({
      message_id: m.id,
      from_session_id: m.from_session_id,
      from_session_name: m.from_session_name ?? 'unknown',
      question: m.question,
      created_at: m.created_at,
    })),
    total: pending.length,
  }
}

export const respondSchema = z.object({
  session_id: z.string().uuid(),
  message_id: z.string().uuid(),
  answer: z.string().min(1).max(10000),
})

export async function respond(
  input: z.infer<typeof respondSchema>,
  env: Env,
  account: AccountAuthContext,
): Promise<RespondOutput> {
  const session = await getAgentSession(env.DB, input.session_id)
  if (!session || session.account_id !== account.account_id) {
    throw new Error('Session not found')
  }

  const { clean, flagged, flags } = await sanitiseTaskDescription(input.answer)
  if (flagged) {
    throw new Error(`Answer contains disallowed patterns: ${flags.join(', ')}`)
  }

  const now = nowUnix()
  const updated = await answerMessage(env.DB, input.message_id, input.session_id, clean, now)
  if (!updated) {
    const msg = await getMessageById(env.DB, input.message_id)
    if (!msg) throw new Error('Message not found')
    if (msg.to_session_id !== input.session_id) throw new Error('Message is not addressed to this session')
    throw new Error(`Message cannot be answered from status: ${msg.status}`)
  }

  // Strengthen connection (respond also counts)
  const msg = await getMessageById(env.DB, input.message_id)
  if (msg) {
    await upsertConnection(env.DB, account.account_id, msg.from_session_id, msg.to_session_id, now)

    // Auto-write to knowledge graph if this was a capability-routed message
    if (msg.capability) {
      const knowledgeId = crypto.randomUUID()
      const topic = msg.question.length > 100 ? msg.question.slice(0, 97) + '...' : msg.question
      insertKnowledge(env.DB, {
        id: knowledgeId,
        account_id: account.account_id,
        session_id: input.session_id,
        topic,
        content: clean,
        tags: JSON.stringify([msg.capability]),
        created_at: now,
        updated_at: now,
        source_message_id: msg.id,
        capability: msg.capability,
      }).catch(() => {})

      // First-answer-wins: expire sibling pending messages
      expireSiblingCapabilityMessages(env.DB, msg.id, msg.from_session_id, msg.capability).catch(() => {})
    }
  }

  return { message_id: input.message_id, status: 'answered' }
}

export const getResponseSchema = z.object({
  message_id: z.string().uuid(),
})

export async function getResponse(
  input: z.infer<typeof getResponseSchema>,
  env: Env,
  account: AccountAuthContext,
): Promise<GetResponseOutput> {
  const msg = await getMessageById(env.DB, input.message_id)
  if (!msg || msg.account_id !== account.account_id) {
    throw new Error('Message not found')
  }

  return {
    message_id: msg.id,
    status: msg.status,
    answer: msg.answer,
  }
}
