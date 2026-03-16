-- HexGrid D1 Schema — Orchestration Platform
-- Run: wrangler d1 execute hexgrid-db --local --file=worker/src/db/schema.sql

-- ─── USERS + AUTH ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  user_id                     TEXT PRIMARY KEY,
  email                       TEXT UNIQUE NOT NULL,
  email_verified_at           INTEGER,
  account_api_key_hash        TEXT,
  account_api_key_prefix      TEXT,
  created_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS auth_codes (
  email           TEXT PRIMARY KEY,
  code_hash       TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  attempts_left   INTEGER NOT NULL DEFAULT 5,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON auth_codes(expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  token_hash      TEXT UNIQUE NOT NULL,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS device_auth_requests (
  device_code      TEXT PRIMARY KEY,
  user_code        TEXT UNIQUE NOT NULL,
  user_id          TEXT,
  client_name      TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  approved_at      INTEGER,
  consumed_at      INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_device_auth_user_code ON device_auth_requests(user_code);
CREATE INDEX IF NOT EXISTS idx_device_auth_status ON device_auth_requests(status, expires_at);

CREATE TABLE IF NOT EXISTS cli_tokens (
  token_id         TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  token_hash       TEXT UNIQUE NOT NULL,
  token_prefix     TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER,
  last_used_at     INTEGER,
  revoked_at       INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_cli_tokens_user ON cli_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_cli_tokens_expires ON cli_tokens(expires_at);

CREATE TABLE IF NOT EXISTS repo_hex_claims (
  account_id      TEXT NOT NULL,
  repo_key        TEXT NOT NULL,
  repo_url        TEXT NOT NULL,
  hex_id          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  released_at     INTEGER,
  PRIMARY KEY (account_id, repo_key),
  FOREIGN KEY (account_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_repo_hex_claims_hex ON repo_hex_claims(hex_id);
CREATE INDEX IF NOT EXISTS idx_repo_hex_claims_seen ON repo_hex_claims(last_seen_at);

-- ─── AGENT SESSIONS ──────────────────────────────────────────────────────────
-- Live agent connections. One row per connected Claude Code / MCP client.

CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id      TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  repo_url        TEXT,
  description     TEXT,
  capabilities    TEXT NOT NULL DEFAULT '[]',
  hex_id          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  last_heartbeat  INTEGER NOT NULL,
  connected_at    INTEGER NOT NULL,
  disconnected_at INTEGER,
  is_listener     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_account ON agent_sessions(account_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_heartbeat ON agent_sessions(last_heartbeat);

-- ─── KNOWLEDGE ───────────────────────────────────────────────────────────────
-- Persistent shared memory. Agents write insights; all sessions on account can search.

CREATE TABLE IF NOT EXISTS knowledge (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  topic             TEXT NOT NULL,
  content           TEXT NOT NULL,
  tags              TEXT NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  source_message_id TEXT,
  capability        TEXT,
  FOREIGN KEY (account_id) REFERENCES users(user_id),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_account ON knowledge(account_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON knowledge(account_id, topic);
CREATE INDEX IF NOT EXISTS idx_knowledge_capability ON knowledge(account_id, capability);

-- ─── MESSAGES ────────────────────────────────────────────────────────────────
-- Async request/response between agent sessions.

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  from_session_id TEXT NOT NULL,
  to_session_id   TEXT NOT NULL,
  question        TEXT NOT NULL,
  answer          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      INTEGER NOT NULL,
  answered_at     INTEGER,
  expires_at      INTEGER NOT NULL,
  capability      TEXT,
  context         TEXT,
  FOREIGN KEY (account_id) REFERENCES users(user_id),
  FOREIGN KEY (from_session_id) REFERENCES agent_sessions(session_id),
  FOREIGN KEY (to_session_id) REFERENCES agent_sessions(session_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_session_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_session_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_messages_capability ON messages(account_id, capability, status);

-- ─── CONNECTIONS ─────────────────────────────────────────────────────────────
-- Interaction graph between sessions. Strengthens with each ask/respond.

CREATE TABLE IF NOT EXISTS connections (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  session_a_id    TEXT NOT NULL,
  session_b_id    TEXT NOT NULL,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  strength        INTEGER NOT NULL DEFAULT 0,
  last_interaction INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES users(user_id),
  FOREIGN KEY (session_a_id) REFERENCES agent_sessions(session_id),
  FOREIGN KEY (session_b_id) REFERENCES agent_sessions(session_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_pair ON connections(account_id, session_a_id, session_b_id);
CREATE INDEX IF NOT EXISTS idx_connections_account ON connections(account_id);

-- ─── RATE LIMITS ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rate_limits (
  key           TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);
