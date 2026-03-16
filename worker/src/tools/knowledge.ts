// HexGrid — Knowledge tools (write, search)

import { z } from 'zod'
import type { AccountAuthContext, Env, SearchKnowledgeOutput, WriteKnowledgeOutput } from '../lib/types'
import { nowUnix } from '../lib/auth'
import { getAgentSession, insertKnowledge, searchKnowledge as searchKnowledgeDb } from '../db/queries'
import { normaliseRepoUrl } from '../lib/repo'
import { sanitiseTaskDescription } from '../lib/sanitise'

const knowledgeStatusSchema = z.enum(['candidate', 'canonical', 'stale', 'archived'])
const knowledgeFreshnessSchema = z.enum(['stable', 'working', 'volatile'])
const knowledgeSourceRefSchema = z.object({
  path: z.string().min(1).max(500),
  note: z.string().max(200).optional(),
})

function normaliseKind(input?: string): string {
  const raw = input?.trim().toLowerCase() ?? 'note'
  const clean = raw.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return clean || 'note'
}

export const writeKnowledgeSchema = z.object({
  session_id: z.string().uuid(),
  topic: z.string().min(1).max(100),
  content: z.string().min(1).max(5000),
  tags: z.array(z.string().max(50)).max(10).optional(),
  repo_url: z.string().max(500).optional(),
  kind: z.string().max(50).optional(),
  status: knowledgeStatusSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  freshness: knowledgeFreshnessSchema.optional(),
  source_refs: z.array(knowledgeSourceRefSchema).max(20).optional(),
  verified_at: z.number().int().positive().optional(),
  expires_at: z.number().int().positive().optional(),
  capability: z.string().max(100).optional(),
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
  const repoUrl = input.repo_url?.trim() || session.repo_url || ''
  const sourceRefs = input.source_refs
    ? input.source_refs
      .map(ref => ({
        path: ref.path.trim(),
        ...(ref.note?.trim() ? { note: ref.note.trim() } : {}),
      }))
      .filter(ref => ref.path)
    : []
  const kind = normaliseKind(input.kind)
  const status = input.status ?? 'canonical'
  const confidence = input.confidence ?? (status === 'candidate' ? 0.55 : 0.8)
  const freshness = input.freshness ?? 'working'
  const verifiedAt = input.verified_at ?? (status === 'canonical' ? now : null)
  const expiresAt = input.expires_at ?? null

  await insertKnowledge(env.DB, {
    id,
    account_id: account.account_id,
    session_id: input.session_id,
    repo_key: repoUrl ? normaliseRepoUrl(repoUrl) : '',
    kind,
    status,
    topic: input.topic.trim(),
    content: clean,
    tags: JSON.stringify(tags),
    source_refs: JSON.stringify(sourceRefs),
    confidence,
    freshness,
    created_at: now,
    updated_at: now,
    verified_at: verifiedAt,
    expires_at: expiresAt,
    source_message_id: null,
    capability: input.capability?.trim() || null,
  })

  return { id, topic: input.topic.trim(), kind, status }
}

export const searchKnowledgeSchema = z.object({
  query: z.string().max(200).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  repo_key: z.string().max(500).optional(),
  kind: z.string().max(50).optional(),
  status: knowledgeStatusSchema.optional(),
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
    {
      query: input.query,
      tags: input.tags,
      repoKey: input.repo_key?.trim() || undefined,
      kind: input.kind ? normaliseKind(input.kind) : undefined,
      status: input.status,
      limit: input.limit ?? 20,
    },
  )

  return {
    entries: entries.map(e => ({
      id: e.id,
      repo_key: e.repo_key,
      kind: e.kind,
      status: e.status,
      topic: e.topic,
      content: e.content,
      tags: JSON.parse(e.tags) as string[],
      source_refs: JSON.parse(e.source_refs) as Array<{ path: string; note?: string }>,
      confidence: e.confidence,
      freshness: e.freshness,
      session_name: e.session_name ?? 'unknown',
      created_at: e.created_at,
      updated_at: e.updated_at,
      verified_at: e.verified_at,
      expires_at: e.expires_at,
      capability: e.capability,
    })),
    total: entries.length,
  }
}
