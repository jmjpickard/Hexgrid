-- Migration 001: Knowledge Routing
-- Adds capability-based message routing, knowledge provenance, and listener flag

-- Capability-based message routing + context field
ALTER TABLE messages ADD COLUMN capability TEXT;
ALTER TABLE messages ADD COLUMN context TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_capability ON messages(account_id, capability, status);

-- Knowledge provenance
ALTER TABLE knowledge ADD COLUMN source_message_id TEXT;
ALTER TABLE knowledge ADD COLUMN capability TEXT;
CREATE INDEX IF NOT EXISTS idx_knowledge_capability ON knowledge(account_id, capability);

-- Listener flag on sessions
ALTER TABLE agent_sessions ADD COLUMN is_listener INTEGER NOT NULL DEFAULT 0;
