-- Migration 003: Knowledge Notes
-- Adds repo scoping, note metadata, and provenance fields for knowledge entries

ALTER TABLE knowledge ADD COLUMN repo_key TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge ADD COLUMN kind TEXT NOT NULL DEFAULT 'note';
ALTER TABLE knowledge ADD COLUMN status TEXT NOT NULL DEFAULT 'canonical';
ALTER TABLE knowledge ADD COLUMN source_refs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE knowledge ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7;
ALTER TABLE knowledge ADD COLUMN freshness TEXT NOT NULL DEFAULT 'working';
ALTER TABLE knowledge ADD COLUMN verified_at INTEGER;
ALTER TABLE knowledge ADD COLUMN expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_knowledge_repo_status ON knowledge(account_id, repo_key, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_kind_status ON knowledge(account_id, kind, status);
