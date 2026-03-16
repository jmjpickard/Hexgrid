# HexGrid Knowledge V1

## Summary

HexGrid knowledge should be a shared memory and retrieval layer for local Claude/Codex
sessions, not a hosted answering agent by default.

V1 keeps reasoning local:

- local agent sessions investigate repos, interpret search results, and answer questions
- HexGrid stores durable notes, episodic learnings, provenance, freshness metadata, and
  retrieval indexes
- HexGrid returns evidence, not a centrally generated answer

This gives HexGrid the compounding-memory behavior of an Obsidian-style vault without
making Obsidian itself a hard dependency and without requiring a graph database as the
source of truth.

## Product Decision

HexGrid should be:

- Markdown-native at the authoring layer
- structured at the metadata layer
- hybrid-search at the retrieval layer
- graph-enabled as a derived view
- local-first for reasoning

HexGrid should not be:

- a raw transcript dump
- a manually authored triple store
- a hosted copilot in the hot path for every question

## Principles

1. Knowledge first, live agent second.
2. Canonical notes beat chat logs.
3. Every fact should have provenance and freshness.
4. Graph structure should emerge from notes and references.
5. Local sessions do the interpretation unless a hosted answer is explicitly requested.
6. Store reusable deltas, not every token of every conversation.

## V1 Scope

Included:

- repo onboarding
- shared note store
- note metadata and provenance
- candidate learnings written back from local sessions
- lexical search with clear upgrade path to hybrid search
- backlinks / related-note graph as a derived feature
- per-account and per-repo namespaces

Excluded:

- hosted HexGrid-generated answers by default
- full GraphRAG indexing for every account
- automatic persistence of full chat transcripts
- manual graph authoring as the primary UX

## Core UX

### 1. Repo onboarding

Add a CLI command:

```bash
hexgrid onboard
```

`hexgrid onboard` should launch a supervised local investigation session that produces a
repo dossier and pushes it to HexGrid.

Suggested flow:

1. Detect repo root, remote, package manager, languages, and likely frameworks.
2. Run an orchestrator-workers style investigation locally.
3. Produce a first-pass dossier.
4. Upload the dossier as canonical notes to HexGrid.
5. Show the user what was created and what still needs verification.

### 2. Asking a question

Normal question flow:

1. Local session calls HexGrid search.
2. HexGrid returns ranked notes, chunks, provenance, freshness, and related links.
3. Local session interprets the results and answers.
4. If confidence is low, local session asks a live agent.
5. If a new reusable fact was learned, the session writes back a candidate note.

### 3. Continuous write-back

At the end of useful interactions, local sessions should write candidate learnings rather
than directly mutating canonical knowledge.

This creates a promotion pipeline:

- `candidate`: recent, useful, not yet verified
- `canonical`: stable and trusted
- `stale`: once useful but needs re-checking
- `archived`: no longer relevant but retained for history

## Output of `hexgrid onboard`

The onboarding job should create a small, opinionated set of notes.

Required notes:

- `repo-brief`
- `architecture`
- `commands`
- `glossary`
- `pitfalls`
- `open-questions`

Optional notes when discovered:

- `deployments`
- `data-model`
- `integrations`
- `runbooks`
- `decision-log`
- `testing`

Suggested generated structure:

```text
repo-brief.md
architecture.md
commands.md
glossary.md
pitfalls.md
open-questions.md
```

Each note should be readable on its own and link to related notes.

## Note Model

Canonical storage format should be Markdown plus frontmatter-style metadata.

Example:

```md
---
id: kno_01hxyz
account_id: acct_123
repo_id: repo_api_service
kind: architecture
status: canonical
title: Request lifecycle
tags: [api, auth, middleware]
links:
  - commands
  - pitfalls
source_refs:
  - path: worker/src/index.ts
    note: Main request router
created_by: sess_123
created_at: 1773638400
updated_at: 1773638400
verified_at: 1773638400
confidence: 0.92
freshness: stable
expires_at:
---

Requests enter through the worker edge handler, pass through auth middleware,
then route into account-scoped tool handlers...
```

Required metadata:

- `id`
- `account_id`
- `repo_id`
- `kind`
- `status`
- `title`
- `created_by`
- `created_at`
- `updated_at`
- `confidence`
- `freshness`

Useful optional metadata:

- `tags`
- `links`
- `source_refs`
- `verified_at`
- `expires_at`
- `owners`
- `capability`

## Note Kinds

Recommended V1 note kinds:

- `repo-brief`
- `architecture`
- `commands`
- `glossary`
- `pitfall`
- `runbook`
- `decision`
- `incident`
- `qa`
- `session-summary`
- `open-question`

Notes should be small enough to retrieve selectively and large enough to make sense without
opening ten other files.

## Knowledge Namespaces

Knowledge should be scoped in this order:

1. account
2. repo
3. topic
4. note
5. author/session

This enables:

- per-repo search
- cross-repo learning at the account level
- personal or session-specific candidate notes
- later support for team, environment, or branch-specific overlays

## Retrieval Model

V1 retrieval should stay simple and transparent.

Search order:

1. canonical notes in the current repo
2. canonical notes elsewhere in the account
3. recent candidate learnings
4. related notes via links/tags
5. live agent fallback

V1 ranking inputs:

- query match against title and body
- repo match
- note kind
- status
- freshness
- confidence
- recency
- explicit links

V1 can ship with lexical search plus metadata ranking.

Planned upgrade:

- chunk notes
- generate embeddings
- use hybrid retrieval
- preserve provenance so the local session can cite exact notes/chunks

## Derived Graph

The graph should be derived from note metadata and references, not manually authored.

V1 edges:

- note -> note via `links`
- note -> repo
- note -> capability
- note -> source file
- session -> note authoring event

V1 graph use cases:

- backlinks
- related notes
- local graph view for one repo or one topic
- discovery of duplicate or overlapping knowledge

This is enough to capture most of the useful "Obsidian graph" feeling without needing a
general-purpose graph database.

## Write-Back Policy

Not every interaction should write to shared memory.

Write back only when the output is:

- reusable
- specific
- scoped
- sourceable
- likely to matter again

Do not write back:

- raw conversational filler
- transient guesses with no source
- project-private details that should not leave the local machine
- duplicated knowledge with no added value

## Inference Boundary

Default V1 position:

- local agent sessions do reasoning and answer composition
- HexGrid does storage, retrieval, permissions, and provenance

Optional background intelligence at the HexGrid layer:

- embeddings
- deduplication
- stale-note detection
- candidate clustering
- note summarization

Explicitly out of the hot path:

- hosted question answering
- centralized long-form synthesis for every search

This keeps product cost and trust aligned with the "shared memory bank" model.

## Storage Model

Recommended backend split:

- D1: note metadata, status, provenance, edges, quotas, note listings
- R2: note bodies, onboarding reports, larger artifacts, optional archived transcripts
- Vector index: note chunks for hybrid retrieval

This avoids overloading the relational store with large documents while keeping metadata
queries cheap and simple.

## Suggested Data Model Changes

The current `knowledge` table is a good seed but is too flat for V1.

Suggested evolution:

### `knowledge_notes`

- `id`
- `account_id`
- `repo_id`
- `session_id`
- `kind`
- `status`
- `title`
- `body_r2_key` or inline `body`
- `capability`
- `confidence`
- `freshness`
- `created_at`
- `updated_at`
- `verified_at`
- `expires_at`

### `knowledge_tags`

- `note_id`
- `tag`

### `knowledge_links`

- `from_note_id`
- `to_note_id`
- `link_type`

### `knowledge_sources`

- `note_id`
- `source_type`
- `source_ref`
- `source_note`

### `knowledge_candidates`

Optional if candidate state should be isolated from canonical notes; otherwise use a shared
`status` field in `knowledge_notes`.

## Dashboard UX

The dashboard should not begin with a giant network graph.

The best V1 knowledge UI is:

- repo home / dossier
- search bar
- filters for kind, status, repo, freshness
- note reader with source refs
- related notes / backlinks panel
- "Promote to canonical" action for candidates
- "Ask live agent" fallback action

Good default tabs:

- `Overview`
- `Knowledge`
- `Candidates`
- `Messages`

## Quotas and Pricing Shape

HexGrid should not primarily meter by raw storage bytes.

Metering should focus on:

- onboarding runs
- indexed tokens
- background enrichment jobs
- hosted answering, if added later

Storage should be treated as a generous quota because Markdown knowledge is cheap relative
to model work.

Suggested quota model:

- generous note storage per account
- bounded candidate retention window
- bounded archived transcript retention
- explicit monthly budget for indexing/enrichment jobs

## Rollout Plan

### Phase 1

- keep local-first reasoning
- add `hexgrid onboard`
- upgrade note model in the API
- add statuses, freshness, provenance
- improve dashboard from flat list to note explorer

### Phase 2

- add candidate promotion flow
- add backlinks / related notes
- add chunking and embeddings
- add repo-scoped and account-scoped hybrid retrieval

### Phase 3

- add nightly consolidation jobs
- add stale-note detection
- add richer graph exploration
- optionally add hosted "Ask HexGrid" for humans in the web app

## Non-Goals for V1

- no promise that HexGrid itself is smarter than the local agent
- no automatic storage of everything
- no requirement that users install Obsidian
- no requirement that every repo gets a heavy graph extraction pipeline

## Decision Summary

If HexGrid is the memory bank and local Claude/Codex sessions are the interpreters, the
right V1 is:

- Markdown-native knowledge
- structured metadata
- local-first reasoning
- knowledge-first retrieval
- candidate-to-canonical write-back
- derived graph, not graph-first authoring

That is the smallest version that compounds over time without creating unnecessary model
spend or UX complexity.
