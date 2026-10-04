-- Company Service V1 — initial schema
-- All timestamps are ISO-8601 UTC strings. All ids are prefixed ULID-ish tokens.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Connections: model providers, email accounts. config_enc holds AES-GCM
-- encrypted JSON (secrets); meta holds non-secret display info.
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,                 -- 'model_provider' | 'email'
  provider TEXT NOT NULL,             -- 'openai'|'anthropic'|'openai_compatible'|'local_dev'|'gmail'|'demo_outbound'
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active | revoked | error
  config_enc TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_connections_user ON connections(user_id);

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domains TEXT,                       -- JSON array
  adapter_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Coverage is explicit per company + issue type + channel. Never "company supported".
CREATE TABLE company_coverage (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  country TEXT NOT NULL DEFAULT 'US',
  issue_type TEXT NOT NULL,           -- 'refund_not_received' | ... | 'any'
  channel TEXT NOT NULL,              -- 'email' | 'chat' | 'api' | 'mcp' | 'protocol' | 'manual'
  auth_requirements TEXT,             -- human-readable requirements
  automation_level TEXT NOT NULL,     -- AUTOMATED | ASSISTED | MANUAL_HANDOFF | TEMPORARILY_UNAVAILABLE | UNSUPPORTED
  limitations TEXT,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED', -- VERIFIED | SIMULATED | ASSISTED | UNVERIFIED
  last_verified_at TEXT,
  adapter_version TEXT,
  health TEXT NOT NULL DEFAULT 'unknown',  -- healthy | degraded | down | unknown
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_coverage_company ON company_coverage(company_id);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  company_id TEXT REFERENCES companies(id),
  company_name TEXT,
  title TEXT NOT NULL,
  issue_type TEXT,
  desired_outcome TEXT,
  amount_cents INTEGER,
  currency TEXT DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  status_reason TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  meta TEXT,
  intake_text TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_cases_user ON cases(user_id);
CREATE INDEX idx_cases_status ON cases(status);

-- Material factual claims with provenance. Status is one of:
-- CUSTOMER_STATED | DOCUMENT_VERIFIED | MERCHANT_STATED | SYSTEM_VERIFIED |
-- INFERRED | CONFLICTING | UNKNOWN
CREATE TABLE case_claims (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  text TEXT NOT NULL,
  claim_status TEXT NOT NULL DEFAULT 'CUSTOMER_STATED',
  source_type TEXT NOT NULL DEFAULT 'customer',  -- customer|evidence|merchant|system|inference
  evidence_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_claims_case ON case_claims(case_id);

CREATE TABLE case_evidence (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,                 -- statement|image|pdf|receipt|email|merchant_reply|screenshot|tracking|order_info|note
  text TEXT,
  r2_key TEXT,
  mime TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  source TEXT NOT NULL DEFAULT 'customer',  -- customer|merchant|system
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_evidence_case ON case_evidence(case_id);

-- Bounded authority. The model/merchant cannot expand this. JSON arrays of
-- human-readable permissions + structured action grants.
CREATE TABLE case_mandates (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | active | revoked | expired
  authorized_json TEXT NOT NULL,         -- JSON array of strings
  approval_required_json TEXT NOT NULL,  -- JSON array of strings
  prohibited_json TEXT,                  -- JSON array of strings
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT
);
CREATE INDEX idx_mandates_case ON case_mandates(case_id);

CREATE TABLE case_plans (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  version INTEGER NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | active | completed | abandoned
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_plans_case ON case_plans(case_id);

-- Every proposed/executed action. idempotency_key guarantees no duplicates
-- across restarts/retries.
CREATE TABLE case_actions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  plan_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT,
  policy_class TEXT NOT NULL,             -- AUTO_ALLOWED | USER_APPROVAL_REQUIRED | PROHIBITED | UNSUPPORTED
  status TEXT NOT NULL DEFAULT 'proposed',-- proposed | awaiting_approval | approved | rejected | executing | executed | failed | skipped
  idempotency_key TEXT UNIQUE,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approval_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  executed_at TEXT,
  result_json TEXT,
  error TEXT
);
CREATE INDEX idx_actions_case ON case_actions(case_id);
CREATE INDEX idx_actions_status ON case_actions(status);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  action_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail_json TEXT,
  options_json TEXT NOT NULL,             -- JSON array {id,label,kind}
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired | cancelled
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  resolved_option TEXT,
  resolver TEXT
);
CREATE INDEX idx_approvals_case ON approval_requests(case_id);
CREATE INDEX idx_approvals_status ON approval_requests(status);

CREATE TABLE external_conversations (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  channel TEXT NOT NULL,                  -- email | chat
  adapter_id TEXT NOT NULL,
  external_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open',    -- open | closed | failed
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_conversations_case ON external_conversations(case_id);

CREATE TABLE external_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES external_conversations(id),
  direction TEXT NOT NULL,                -- out | in
  subject TEXT,
  body TEXT NOT NULL,
  meta_json TEXT,
  status TEXT NOT NULL DEFAULT 'recorded',-- recorded | sent | delivered | failed | received
  dedup_hash TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_messages_conversation ON external_messages(conversation_id);

CREATE TABLE follow_ups (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,                     -- check_commitment | send_followup | escalate_check
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | fired | cancelled
  payload_json TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fired_at TEXT
);
CREATE INDEX idx_followups_due ON follow_ups(status, due_at);
CREATE INDEX idx_followups_case ON follow_ups(case_id);

-- Append-only outcome trail. Statuses:
-- REQUESTED | ACKNOWLEDGED | PROMISED | APPROVED | ISSUED | RECEIVED |
-- VERIFIED_RESOLVED | DENIED | UNRESOLVED
CREATE TABLE outcome_events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  status TEXT NOT NULL,
  detail TEXT,
  evidence_note TEXT,
  actor TEXT NOT NULL DEFAULT 'system',   -- customer | agent | merchant | system
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_outcomes_case ON outcome_events(case_id);

-- Append-only case timeline/audit. Every agent action lands here.
CREATE TABLE case_events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',   -- customer | agent | merchant | system | policy
  data_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_case_events_case ON case_events(case_id, created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  case_id TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',  -- info | warning | security | error
  data_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_case ON audit_events(case_id);
CREATE INDEX idx_audit_type ON audit_events(type);

CREATE TABLE cost_events (
  id TEXT PRIMARY KEY,
  case_id TEXT,
  kind TEXT NOT NULL,                     -- model | browser | email | storage | tool | operator
  provider TEXT,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  units REAL,
  unit_kind TEXT,                         -- tokens | seconds | messages | bytes
  cost_micro_usd INTEGER,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_cost_case ON cost_events(case_id);

-- Deterministic test merchant's own persistent state (DEMO fixture).
CREATE TABLE merchant_sim_state (
  merchant_id TEXT NOT NULL,
  case_key TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (merchant_id, case_key)
);
