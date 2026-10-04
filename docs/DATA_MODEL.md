# Data Model

D1, 20 tables, `migrations/0001_init.sql`. All timestamps ISO-8601 UTC text;
ids are prefixed tokens (`case_`, `ev_`, `act_`, …). JSON stored as TEXT.

| Table | Role |
|---|---|
| `users` | email + PBKDF2 password_hash (`salt:hex`) |
| `sessions` | token_hash (sha256), csrf_token, expires_at |
| `connections` | model/email/provider connections; `config_enc` AES-GCM secrets; meta JSON |
| `companies` | id, name, domains, adapter_id |
| `company_coverage` | per company×issue×channel: automation_level, verification_status, limitations, adapter_version, health, last_verified_at |
| `cases` | user_id, company_id/name, issue_type, status, objective JSON, meta JSON (orderRef/trackingRef/scenario), paused |
| `case_claims` | text, kind, status (provenance), source_type, evidence_id, note |
| `case_evidence` | kind, text/mime/size, sha256, r2_key, source, label |
| `case_mandates` | version, status, authorized/approvalRequired/prohibited JSON, expires_at |
| `case_plans` | provider plan JSON, version |
| `case_actions` | kind, payload_json, policy_class, grant, status, result_json, provider/model, attempts |
| `approval_requests` | kind, summary, detail, options JSON, status, decided_at/by |
| `external_conversations` | channel, external_ref, status |
| `external_messages` | conversation_id, direction, subject, body, channel, status, dedupe_key UNIQUE |
| `follow_ups` | kind, due_at, status (pending/fired/cancelled), fired_at |
| `outcome_events` | status, detail — append-only honest outcome trail |
| `case_events` | type, actor, data JSON — the inspectable timeline |
| `audit_events` | security-relevant events (injection, csrf, auth, revocation) |
| `cost_events` | kind, provider, model, tokens_in/out, micro_usd, detail |
| `merchant_sim_state` | deterministic Test Merchant state per case |

## Provenance (claims.status)

`CUSTOMER_STATED`, `DOCUMENT_VERIFIED`, `MERCHANT_STATED`, `SYSTEM_VERIFIED`,
`INFERRED`, `CONFLICTING`, `UNKNOWN` — claims never silently upgrade; a
merchant's promise stays `MERCHANT_STATED` until receipt is verified.

## Multi-tenancy

Every case-scoped table carries `case_id` → `cases.user_id` → `users.id`.
All queries filter by the session user — there are no cross-tenant reads.
Data-isolation test: user B cannot read or mutate user A's case (404/403).
