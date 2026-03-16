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
