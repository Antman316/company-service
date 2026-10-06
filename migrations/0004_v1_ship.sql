-- 0004_v1_ship.sql — additive V1-ship schema per docs/V1_SHIP_SPEC.md §3.
-- Prod has no d1_migrations tracker (verified 2026-10-06); every statement is
-- written to be safe on a partially-migrated database: CREATE TABLE/INDEX
-- IF NOT EXISTS everywhere, INSERT OR IGNORE for seeds. ALTER TABLE ADD
-- COLUMN cannot be made idempotent in SQLite — the d10a apply path treats
-- "duplicate column name" as already-applied, and wrangler/applyD1Migrations
-- applies each migration file exactly once.

-- ---------------------------------------------------------------------------
-- M7 — account hardening
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;

CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notification_prefs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, kind)
);

-- ---------------------------------------------------------------------------
-- M3 — escalation engine
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS case_escalations (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL,
  rung        INTEGER NOT NULL,
  action_id   TEXT,
  status      TEXT NOT NULL DEFAULT 'proposed',  -- proposed|executed|awaiting_approval|rejected|skipped
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(case_id, rung)
);
CREATE INDEX IF NOT EXISTS idx_case_escalations_case ON case_escalations(case_id);

-- Deadlines always carry a source label: CUSTOMER_STATED | MERCHANT_STATED |
-- COMPUTED. Nothing here presents a computed deadline as authoritative.
CREATE TABLE IF NOT EXISTS case_deadlines (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- promised_date|return_window|chargeback_window|supervisor_response|complaint_window
  due_at      TEXT NOT NULL,
  source      TEXT NOT NULL,            -- CUSTOMER_STATED|MERCHANT_STATED|COMPUTED
  status      TEXT NOT NULL DEFAULT 'open',     -- open|met|missed|cancelled
  note        TEXT,
  notified_7d INTEGER NOT NULL DEFAULT 0,
  notified_2d INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_case_deadlines_case ON case_deadlines(case_id, status);
CREATE INDEX IF NOT EXISTS idx_case_deadlines_due  ON case_deadlines(status, due_at);

-- ---------------------------------------------------------------------------
-- M6 — merchant playbooks (created now; populated by the M6 merchant pass)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_playbooks (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  support_email      TEXT,
  chat_url           TEXT,
  chat_selectors     TEXT,            -- JSON
  executive_contact  TEXT,
  return_window_days INTEGER,
  policy_url         TEXT,
  policy_quotes      TEXT,            -- JSON array of verbatim policy text
  known_deflections  TEXT,            -- JSON array
  what_works         TEXT,            -- JSON array
  last_verified_at   TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(company_id, version)
);

-- coverage channels gain 'form' as a value (TEXT column — no DDL needed);
-- the tier label is new column data, populated by the M6 directory pass.
ALTER TABLE company_coverage ADD COLUMN verification_tier TEXT;

-- ---------------------------------------------------------------------------
-- M5 — chat companion pairing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companion_pairings (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at  TEXT
);

-- ---------------------------------------------------------------------------
-- M8 — billing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_events (
  id           TEXT PRIMARY KEY,
  case_id      TEXT,
  user_id      TEXT NOT NULL,
  kind         TEXT,
  amount_cents INTEGER,
  stripe_id    TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- §11 — abuse & fraud controls
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fraud_signals (
  id          TEXT PRIMARY KEY,
  case_id     TEXT,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS attestations (
  id           TEXT PRIMARY KEY,
  case_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  scope        TEXT NOT NULL,           -- facts|draft_review
  text_version TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
