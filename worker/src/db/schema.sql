-- HexGrid D1 Schema
-- Run: wrangler d1 execute hexgrid-db --local --file=worker/src/db/schema.sql

-- ─── USERS + AUTH ─────────────────────────────────────────────────────────────
-- Human account model for dashboard ownership and auth.

CREATE TABLE IF NOT EXISTS users (
  user_id                     TEXT PRIMARY KEY,
  email                       TEXT UNIQUE NOT NULL,
  email_verified_at           INTEGER,
  starter_credits_granted_at  INTEGER,
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

-- ─── HEXES ────────────────────────────────────────────────────────────────────
-- Core agent registry. One row per registered agent.

CREATE TABLE IF NOT EXISTS hexes (
  hex_id            TEXT PRIMARY KEY,   -- H3 index (spatial address)
  public_key        TEXT UNIQUE NOT NULL,
  owner_email       TEXT NOT NULL,
  agent_name        TEXT NOT NULL,
  description       TEXT NOT NULL,      -- one-line description
  domain            TEXT NOT NULL,      -- coding|data|legal|finance|marketing|writing|other
  capabilities      TEXT NOT NULL,      -- JSON array of strings
  price_per_task    INTEGER NOT NULL,   -- credits per task
  availability      TEXT NOT NULL,      -- JSON: {timezone, days, hours_start, hours_end}
  allowed_actions   TEXT NOT NULL DEFAULT '["read","analyse","respond"]', -- JSON array
  reputation_score  REAL NOT NULL DEFAULT 50.0,
  total_tasks       INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1, -- 1=active, 0=suspended
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hexes_domain ON hexes(domain);
CREATE INDEX IF NOT EXISTS idx_hexes_reputation ON hexes(reputation_score DESC);
CREATE INDEX IF NOT EXISTS idx_hexes_active ON hexes(active);

-- ─── TASKS ────────────────────────────────────────────────────────────────────
-- Task queue. Consumer submits, provider polls and completes.

CREATE TABLE IF NOT EXISTS tasks (
  task_id           TEXT PRIMARY KEY,   -- UUID
  from_hex          TEXT NOT NULL,      -- consumer's hex_id
  to_hex            TEXT NOT NULL,      -- provider's hex_id
  description       TEXT NOT NULL,      -- sanitised task brief (never raw user input)
  description_hash  TEXT NOT NULL,      -- SHA256 of original (tamper evidence)
  credits_escrowed  INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued', -- queued|active|complete|disputed|refunded
  created_at        INTEGER NOT NULL,
  claimed_at        INTEGER,
  completed_at      INTEGER,
  result_hash       TEXT,               -- SHA256 of result (integrity check)
  FOREIGN KEY (from_hex) REFERENCES hexes(hex_id),
  FOREIGN KEY (to_hex) REFERENCES hexes(hex_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_to_hex ON tasks(to_hex, status);
CREATE INDEX IF NOT EXISTS idx_tasks_from_hex ON tasks(from_hex);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- ─── INTERACTIONS ─────────────────────────────────────────────────────────────
-- Immutable log of completed interactions. Basis for reputation scoring.

CREATE TABLE IF NOT EXISTS interactions (
  interaction_id        TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL,
  provider_hex          TEXT NOT NULL,
  consumer_hex          TEXT NOT NULL,
  outcome               TEXT NOT NULL,  -- success|failure|disputed
  rating                INTEGER,        -- 1-5, from consumer
  credits_transferred   INTEGER NOT NULL DEFAULT 0,
  platform_fee          INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id),
  FOREIGN KEY (provider_hex) REFERENCES hexes(hex_id)
);

CREATE INDEX IF NOT EXISTS idx_interactions_provider ON interactions(provider_hex, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_interactions_task ON interactions(task_id);

-- ─── CREDITS ──────────────────────────────────────────────────────────────────
-- Credit ledger. One row per account (keyed by email for MVP).

CREATE TABLE IF NOT EXISTS credits (
  account_id      TEXT PRIMARY KEY,   -- owner_email for MVP
  balance         INTEGER NOT NULL DEFAULT 0,
  total_earned    INTEGER NOT NULL DEFAULT 0,
  total_spent     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credits_ledger (
  entry_id         TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL,
  delta            INTEGER NOT NULL,          -- positive=credit, negative=debit
  reason           TEXT NOT NULL,             -- signup_bonus|task_escrow|task_payout|task_fee|manual_adjustment
  task_id          TEXT,
  metadata         TEXT NOT NULL DEFAULT '{}', -- JSON object
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

CREATE INDEX IF NOT EXISTS idx_credits_ledger_account ON credits_ledger(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credits_ledger_task ON credits_ledger(task_id);

CREATE TABLE IF NOT EXISTS agent_api_keys (
  key_id           TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  hex_id           TEXT NOT NULL,
  key_hash         TEXT UNIQUE NOT NULL,
  key_prefix       TEXT NOT NULL,
  name             TEXT NOT NULL,
  scopes           TEXT NOT NULL,              -- JSON array
  created_at       INTEGER NOT NULL,
  last_used_at     INTEGER,
  revoked_at       INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (hex_id) REFERENCES hexes(hex_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_api_keys_hex ON agent_api_keys(hex_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_agent_api_keys_user ON agent_api_keys(user_id, revoked_at);

-- ─── DATA POLICIES ────────────────────────────────────────────────────────────
-- Privacy declarations. Signed by provider at registration.

CREATE TABLE IF NOT EXISTS data_policies (
  hex_id              TEXT PRIMARY KEY,
  retention_hours     INTEGER NOT NULL DEFAULT 0,  -- 0 = delete on task completion
  allows_training     INTEGER NOT NULL DEFAULT 0,  -- 0 = false
  allows_human_review INTEGER NOT NULL DEFAULT 0,  -- 0 = false
  third_party_sharing INTEGER NOT NULL DEFAULT 0,  -- 0 = false
  jurisdiction        TEXT NOT NULL DEFAULT 'UK',
  policy_hash         TEXT NOT NULL,               -- hash of full policy for verification
  signed_at           INTEGER NOT NULL,
  FOREIGN KEY (hex_id) REFERENCES hexes(hex_id)
);

-- ─── SEED DATA ────────────────────────────────────────────────────────────────
-- Tone (Jack's agent) as hex #1

INSERT OR IGNORE INTO hexes (
  hex_id, public_key, owner_email, agent_name, description,
  domain, capabilities, price_per_task, availability,
  allowed_actions, reputation_score, total_tasks, active, created_at
) VALUES (
  '8928308280fffff',
  'hexgrid-founder-key-tone',
  'jack@hexgrid.xyz',
  'Tone',
  'Engineering architecture, code review, and technical strategy',
  'coding',
  '["typescript","system_design","code_review","architecture","api_design"]',
  25,
  '{"timezone":"Europe/London","days":[1,2,3,4,5,6,0],"hours_start":20,"hours_end":8}',
  '["read","analyse","respond"]',
  75.0,
  0,
  1,
  strftime('%s','now')
);

INSERT OR IGNORE INTO data_policies (
  hex_id, retention_hours, allows_training, allows_human_review,
  third_party_sharing, jurisdiction, policy_hash, signed_at
) VALUES (
  '8928308280fffff',
  0, 0, 0, 0, 'UK',
  'founder-policy-v1',
  strftime('%s','now')
);

INSERT OR IGNORE INTO credits (
  account_id, balance, total_earned, total_spent, created_at, updated_at
) VALUES (
  'jack@hexgrid.xyz', 1000, 0, 0,
  strftime('%s','now'), strftime('%s','now')
);
