-- M7 — account, trust & legal (amended spec §M7 + §11 abuse controls)
-- Idempotent only: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

-- Signup consent: the Terms/Privacy acceptance is a fact with legal value.
ALTER TABLE users ADD COLUMN tos_accepted_at TEXT;

-- Generic one-shot tokens for flows that aren't password resets:
--   kind='email_verify'     — verify-email links (TTL 24h)
--   kind='totp_challenge'   — post-password 2FA challenge tickets (TTL 5min)
-- Password resets keep their dedicated 0004 table.
CREATE TABLE IF NOT EXISTS user_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  payload_json TEXT,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id, kind, expires_at);
