// HexGrid — Knowledge tools (write, search)

import { z } from 'zod'
import type { AccountAuthContext, Env, SearchKnowledgeOutput, WriteKnowledgeOutput } from '../lib/types'
import { nowUnix } from '../lib/auth'
import { getAgentSession, insertKnowledge, searchKnowledge as searchKnowledgeDb } from '../db/queries'
import { sanitiseTaskDescription } from '../lib/sanitise'

export const writeKnowledgeSchema = z.object({
  session_id: z.string().uuid(),
  topic: z.string().min(1).max(100),
  content: z.string().min(1).max(5000),
  tags: z.array(z.string().max(50)).max(10).optional(),
})

export async function writeKnowledge(
  input: z.infer<typeof writeKnowledgeSchema>,
  env: Env,
  account: AccountAuthContext,
): Promise<WriteKnowledgeOutput> {
  const session = await getAgentSession(env.DB, input.session_id)
  if (!session || session.account_id !== account.account_id) {
    throw new Error('Session not found')
  }

  const { clean, flagged, flags } = await sanitiseTaskDescription(input.content)
  if (flagged) {
    throw new Error(`Content contains disallowed patterns: ${flags.join(', ')}`)
  }

  const now = nowUnix()
  const id = crypto.randomUUID()
  const tags = input.tags
    ? input.tags.map(t => t.trim().toLowerCase()).filter(Boolean)
    : []

  await insertKnowledge(env.DB, {
    id,
    account_id: account.account_id,
    session_id: input.session_id,
    topic: input.topic.trim(),
    content: clean,
    tags: JSON.stringify(tags),
    created_at: now,
    updated_at: now,
    source_message_id: null,
    capability: null,
  })

  return { id, topic: input.topic.trim() }
}

export const searchKnowledgeSchema = z.object({
  query: z.string().max(200).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  limit: z.number().int().min(1).max(100).optional(),
})

export async function searchKnowledge(
  input: z.infer<typeof searchKnowledgeSchema>,
  env: Env,
  account: AccountAuthContext,
): Promise<SearchKnowledgeOutput> {
  const entries = await searchKnowledgeDb(
    env.DB,
    account.account_id,
    input.query,
    input.tags,
    input.limit ?? 20,
  )

  return {
    entries: entries.map(e => ({
      id: e.id,
      topic: e.topic,
      content: e.content,
      tags: JSON.parse(e.tags) as string[],
      session_name: e.session_name ?? 'unknown',
      created_at: e.created_at,
    })),
    total: entries.length,
  }
}
