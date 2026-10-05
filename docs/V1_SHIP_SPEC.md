# V1 Ship Spec — from verified foundation to shipped product

Status: **DESIGNED** (nothing in this document is built unless it says
"exists today"). Channels in scope: **email + chat only**. Phone/voice is
explicitly out of V1 and starts only after V1 ships.

## 0. Definition of "V1 shipped"

V1 is shipped when a stranger can sign up at
`company-service.agentmasterkey.com`, open a post-purchase case against any
of the launch merchants by typing or forwarding an email, and Company Service
works it over email and assisted chat — escalating past deflection — until the
money is **RECEIVED** or the case is honestly closed, with the customer only
touching it for approvals and chat sends. Every ship gate in §9 must be green.

## 1. Where we are (exists today, VERIFIED unless noted)

| Area | State |
|---|---|
| Auth, sessions, CSRF, tenant isolation | VERIFIED (no email verification / reset / 2FA) |
| Case intake → objective draft → mandate grant | VERIFIED |
| Policy engine, approvals, prohibited set | VERIFIED |
| Honest outcome ladder `REQUESTED…VERIFIED_RESOLVED` | VERIFIED |
| Evidence upload to R2 (allowlist, 10 MB, SHA-256) | VERIFIED |
| Inbound email: Email Routing `cases@` → `email()` | VERIFIED on prod |
| Outbound email: `MAILOUT` `send_email` binding | VERIFIED on prod |
| Case threading (`case+token@`, `[CS-token]`, In-Reply-To) + dedup | VERIFIED |
| Assisted chat lane (draft → "I sent it" → paste reply) | VERIFIED (manual copy/paste) |
| Follow-ups (D1 + `*/5` cron), pause/revoke/cancel | VERIFIED |
| Export / delete-account / credential wipe | VERIFIED |
| Chewy email lane (contact + reply ingest) | VERIFIED (no resolution yet) |
| OpenAI / Anthropic / compatible providers | IMPLEMENTED, NOT LIVE-VERIFIED — all verified flows use `local_dev` |
| Gmail `gmail.send` transport | IMPLEMENTED, NOT LIVE-VERIFIED (no OAuth flow) |
| Outbound attachments, notifications, billing, observability | NOT IMPLEMENTED |

## 2. Milestones

Ordered by dependency. Each milestone is PR-sized-to-small-stack and ends
with its acceptance criteria verified on prod (not only locally).

| # | Milestone | Depends on | Est. |
|---|---|---|---|
| M1 | Real reasoning (live model provider) | API key | 0.5 session |
| M2 | Email lane complete | M1 | 1 session |
| M3 | Escalation engine (beat deflection) | M1 | 1 session |
| M4 | Results & verification of money | M2 | 0.5 session |
| M5 | Chat companion extension | M1, M3 | 1.5 sessions |
| M6 | Merchant directory (25 launch merchants) | M2, M5 | 1 session |
| M7 | Account, trust & legal hardening | — | 0.5 session |
| M8 | Billing | M4 | 0.5 session |
| M9 | Ops & reliability | — | 0.5 session |
| — | Dogfood window (≥10 real cases, 30 days) | M1–M4 | calendar |
| — | Public launch | §9 gates | — |

M7 and M9 can run in parallel with anything. M5 can start as soon as M3's
escalation vocabulary is merged.

---

## M1 — Real reasoning

**Goal:** every agent step (objective extraction, planning, drafting,
reply interpretation, deflection classification) runs on a real model.

- Live-verify one provider adapter (`src/providers/openai.ts` or
  `anthropic.ts`) with a platform key in a worker secret
  `PLATFORM_MODEL_KEY` (BYO keys via Connections stay supported).
- Role routing from `ModelRole`: `light` (classification, extraction) →
  small model; `reasoning` (planning, drafting, escalation) → strong model;
  `vision` (receipt/photo reading) → vision-capable model.
- Structured outputs only: every call returns JSON validated against a
  schema; invalid → one retry → `case_events` `model_output_invalid` and
  fall back to a safe deterministic step (never send unvalidated text).
- Cost: every call writes `cost_events` with real tokens and `micro_usd`;
  per-case soft cap (default $0.50) → pause + approval to continue.
- `local_dev` stays the test provider; CI-free test suite keeps using it.

**Acceptance:** a prod case on a real merchant is planned and drafted by the
live provider; `/economics` shows non-zero real cost; injection tests
(Scenario C) still pass with the live provider in a local run.

## M2 — Email lane complete

### 2.1 Send from the customer's own address (Gmail OAuth)
- Google OAuth app (Testing mode, ≤100 test users until verification).
  Scopes: `gmail.send` only for V1. Reply ingestion stays on `cases@` via
  `Reply-To`/CC so we never need inbox-read scopes.
- `/connections` → "Connect Gmail" → OAuth → encrypted refresh token in
  `connections.config_enc`; refresh-on-401; revoke wipes it (exists).
- Outbound when connected: `From: customer@gmail.com`,
  `Reply-To: case+token@agentmasterkey.com`, `CC: case+token@…` so
  merchant replies-all land in the case. Transport precedence already
  prefers Gmail.
- Fallback when not connected: `MAILOUT` from `case+token@` with a signed
  "on behalf of <customer name>, account email <x>" line (exists
  today minus the account-email line).
- Google verification (sensitive scope) submitted before public launch;
  launch is not blocked on it if the MAILOUT fallback is acceptable.

### 2.2 Forward-to-start intake
- Customer forwards an order/shipping/refund email to `cases@` (no token)
  from their **verified account email** → new DRAFT case for that user.
- Parse with `postal-mime` + `light` model: merchant, order number, items,
  amounts, dates, tracking → `case_claims` as `DOCUMENT_VERIFIED` (the
  original forwarded message is stored as `email` evidence with SHA-256).
- Reply to the customer with a link to review the draft + grant mandate.
- Unknown sender → rejected + audit (exists: `inbound_rejected`).

### 2.3 Outbound attachments
- `send_message` actions may reference `case_evidence` ids; policy requires
  `share_evidence` grant (exists). MIME multipart build for both MAILOUT
  and Gmail; ≤10 MB total; images/PDF only.

### 2.4 Inbound reply classification
New `light`-model classifier on every inbound merchant message, output
stored on `external_messages.meta.classification`:

| Class | Engine response |
|---|---|
| `substantive` | normal interpretation (exists) |
| `autoreply_ack` ("we received your email") | outcome `ACKNOWLEDGED`, keep waiting |
| `channel_redirect` ("this inbox isn't monitored, use chat") | switch case to chat lane (M5) / ASSISTED; record on coverage row |
| `info_request` | WAITING_FOR_CUSTOMER with exact ask |
| `deflection` (empathy + no action) | feed M3 escalation ladder |
| `bounce` / `undeliverable` | mark coverage health `degraded`, try next contact |
| `offer` | approval gating (exists) |

### 2.5 Deliverability
- Verify SPF/DKIM/DMARC on `agentmasterkey.com` (`p=quarantine` minimum);
  doc in `EMAIL_ARCHITECTURE.md`.
- Per-merchant send throttle (max 1 outbound / case / 24 h except replies).

**Acceptance:** (a) real case sent from Anthony's Gmail with merchant reply
ingested into the case; (b) forwarded order email creates a correct DRAFT;
(c) photo attachment received by a real merchant mailbox (send to a test
inbox we control is acceptable); (d) each classifier class covered by tests
with fixture emails.

## M3 — Escalation engine

**Goal:** the agent does not accept "I understand how frustrating that is,
but there's nothing we can do" as an outcome.

### 3.1 Deflection detection
- Classifier (`light`) flags deflection on email + chat messages:
  empathy-without-action, policy-wall without citation, repeat of an
  earlier non-answer, "please allow 5–7 business days" past the stated
  window.
- Two consecutive deflections or one past-deadline promise → next rung.

### 3.2 Ladder (per case, tracked in new `case_escalations` table)

| Rung | Action | Grant / gate |
|---|---|---|
| 1 | Restate facts + cite the merchant's own published policy (from M6 playbook `policy_url` + quoted text) | `request_refund` |
| 2 | Request a human agent / reference number / written confirmation | `request_escalation` |
| 3 | Request supervisor / escalations team, set explicit deadline (5 business days) | `request_escalation` |
| 4 | Executive / corporate customer-relations contact (from playbook) | new grant `contact_executive` (authorized by default, toggleable) |
| 5 | **Draft** card chargeback letter (Fair Credit Billing Act framing for credit cards; Reg E for debit) with timeline + evidence bundle PDF | approval — customer files it |
| 6 | **Draft** complaints: CFPB (if a financial product), FTC ReportFraud, state AG consumer-protection, BBB | approval — customer files it |

- Rungs 5–6 are always **drafts the customer files themselves**; we never
  file on their behalf and never use legal-advice language (copy reviewed
  for "not legal advice" disclaimer).
- Evidence bundle: one generated PDF (timeline, messages, receipts,
  promises vs dates) stored as `case_evidence` kind `pdf`.

### 3.3 Deadline tracker
- New `case_deadlines` rows: merchant return window, promised-by date,
  chargeback window (default 60 days from statement date, customer-entered),
  complaint windows. Cron surfaces `FOLLOW_UP_DUE` 7 and 2 days before each.

**Acceptance:** Test Merchant gains scripted `deflection` and
`stonewall` scenarios; a sim case climbs rungs 1→5 automatically, stops at
rung 5 with an approval card, and the chargeback draft + evidence PDF
render correctly. Policy tests prove rungs 5–6 can never auto-send.

## M4 — Results & money verification

- **Confirm receipt:** when outcome reaches `ISSUED`/`PROMISED`, schedule a
  check at the promised date: customer gets "Did $X arrive?" (yes / no /
  partial amount). Optional: forwarded refund-confirmation email → parsed →
  `RECEIVED` with `DOCUMENT_VERIFIED`.
- `VERIFIED_RESOLVED` only after `RECEIVED` + customer confirm (existing
  ladder semantics preserved; nothing auto-upgrades).
- New per-case fields (`cases.meta.results`): `amount_claimed`,
  `amount_recovered`, `customer_minutes` (self-reported at close),
  `agent_messages_sent`, `days_to_resolution`, `escalation_max_rung`.
- `/results` page (and owner-only `/admin/results`): recovery rate,
  $ recovered, median days, by merchant and by lane. This is the 30-day
  dogfood scoreboard and the go/no-go input.

**Acceptance:** one real case closes `VERIFIED_RESOLVED` with
`amount_recovered > 0` and appears on `/results`.

## M5 — Chat companion (browser extension)

Implements BROWSER_ARCHITECTURE Option B. The customer's own Chrome, their
own logged-in merchant session; **the customer clicks send** in V1.

### 5.1 Extension (Manifest V3, Chrome first)
- Pair with account via short code from `/connections` → scoped token
  (per-user, revocable, stored in `connections`).
- Side panel opens when the active tab matches a merchant chat URL from the
  coverage registry (allowlist only; no activity elsewhere).
- Reads the visible chat transcript via per-merchant DOM selector config
  shipped from the server (`company_coverage.meta.chat_selectors`), with a
  generic fallback (text of the chat container the user highlights once).
- Shows the agent's drafted next message; buttons: **Insert** (places text
  into the chat input — does not press send), **Regenerate**, **I sent it**.
- Streams new merchant messages to `/api/cases/:id/assisted/reply`
  automatically (exists as manual paste today) → classifier (M2.4) →
  deflection → next draft comes from the escalation ladder (M3).
- End-of-chat wrap-up: draft asks for reference number + transcript email;
  saves full transcript as `case_evidence` (kind `email`/`note`) with
  SHA-256; optional visible-tab screenshot as evidence.
- No credential access, no cookie export, no CAPTCHA interaction, no
  auto-send, no background tabs. Permissions: `sidePanel`, `activeTab`,
  `storage`, host permissions only for allowlisted support domains.

### 5.2 Server
- `GET /api/companion/context?url=` → matched case + current draft.
- `POST /api/companion/pair`, `/revoke`.
- Rate-limit + audit every companion call.

### 5.3 Distribution
- Chrome Web Store listing (unlisted for dogfood, public at launch).
- Safari/Firefox: post-V1.

**Acceptance:** on 3 real merchant chats (e.g. Amazon, Walmart, Target) the
transcript is captured live, drafts appear, a deflection triggers an
escalation draft, and the transcript lands in the case — recorded on video.

## M6 — Merchant directory (launch set)

- 25 US merchants, each a `companies` row + `company_coverage` rows per
  channel + a **playbook** (`merchant_playbooks` table):
  `support_email`, `chat_url`, `chat_selectors`, `executive_contact`,
  `return_window_days`, `policy_url`, `policy_quotes[]`,
  `known_deflections[]`, `what_works[]`, `last_verified_at`.
- Seed via idempotent `INSERT OR IGNORE` per row (never early-return seed).
- Proposed launch set: Amazon, Walmart, Target, Best Buy, Costco, Home
  Depot, Lowe's, Chewy, Wayfair, eBay, Etsy, Nike, Apple, Samsung, Dell,
  Zappos, Nordstrom, Macy's, Kohl's, Sephora, Ulta, Temu, Shein, IKEA,
  Newegg.
- Each row's `verification_status` is `VERIFIED` only after a real contact
  through that lane was observed; otherwise `UNVERIFIED` and shown so.
- Monthly health check (cron): bounced emails / changed chat URLs flip
  `health` → `degraded`.

**Acceptance:** ≥15 of 25 merchants have at least one VERIFIED lane
(email contact delivered or chat transcript captured) before launch; the
rest are honestly labeled.

## M7 — Account, trust & legal

- Email verification on signup (required before any outbound send and
  before forward-to-start trusts the sender).
- Password reset via emailed one-time link (MAILOUT).
- TOTP 2FA (optional, encouraged).
- Notifications (MAILOUT to the account email; preferences page):
  merchant replied, approval needed, deadline in 2 days, money check-in,
  case resolved.
- Guided first case on empty dashboard (forward-an-email or type).
- Public pages: Terms, Privacy, "How it works / what we never do",
  "Not legal advice" disclaimer; consent checkbox at signup.
- Abuse controls: max 10 active cases/user, outbound content checks
  (no threats, no false statements — `submit_false_statement` already
  prohibited), report-abuse inbox.

## M8 — Billing

- Stripe Checkout + webhook (worker), customer stored as
  `connections` type `billing`.
- Pricing (to confirm, see §10): first case free; then **20% of
  `amount_recovered`**, capped at $50/case, charged only after
  `VERIFIED_RESOLVED`; $0 if nothing recovered. Optional flat $5 for
  non-monetary outcomes (replacement delivered).
- Invoice shows the evidence that money was received.

## M9 — Ops & reliability

- Cloudflare Workflows for long-running cases (weeks of waiting) with cron
  kept as sweeper; Queues for inbound bursts.
- Error tracking: Sentry (or Workers Logpush → R2) with alert to Anthony.
- Cloudflare rate limiting rules on auth + companion endpoints.
- Daily D1 export to R2 (backup) + restore drill documented.
- Status row stays in Mission Control (exists).
- Move SPA from inlined `src/static.ts` to Workers Assets if a credential
  with assets-upload rights becomes available (nice-to-have).

---

## 3. Data model changes (migration `0003_v1_ship.sql`, additive only)

| Table / column | Purpose |
|---|---|
| `users.email_verified_at`, `users.totp_secret_enc` | M7 |
| `password_resets` (token_hash, expires_at) | M7 |
| `notification_prefs` (user_id, kind, enabled) | M7 |
| `case_escalations` (case_id, rung, action_id, status, at) | M3 |
| `case_deadlines` (case_id, kind, due_at, source, status) | M3 |
| `merchant_playbooks` (company_id, fields per M6, version) | M6 |
| `companion_pairings` (user_id, token_hash, created_at, revoked_at) | M5 |
| `billing_events` (case_id, amount, stripe_id, status) | M8 |
| `external_messages.meta.classification` (JSON, no DDL) | M2.4 |
| `cases.meta.results` (JSON, no DDL) | M4 |

Migration must be safe on the existing prod DB (no new FKs onto existing
rows that could fail on fresh DBs — prior `0003` was removed for this
reason) and applied via d10a D1 query, then `seedRegistry` per-row upserts.

## 4. New / changed API

`POST /api/auth/verify-email`, `POST /api/auth/reset/request`,
`POST /api/auth/reset/confirm`, `POST /api/auth/totp/*`,
`GET/POST /api/connections/gmail/oauth/{start,callback}`,
`GET /api/companion/context`, `POST /api/companion/{pair,revoke}`,
`POST /api/cases/:id/received` (money check-in),
`GET /api/cases/:id/bundle.pdf`, `GET /api/results`,
`POST /api/billing/{checkout,webhook}`, `GET/PUT /api/notifications`.
All behind existing session + CSRF + tenant checks; companion uses its
pairing token.

## 5. UI changes

Dashboard empty-state onboarding; case detail gains **Escalation** rail
(rung, next step, deadlines), **Money** card (claimed / promised /
received), chargeback/complaint draft viewer; `/results`; Connections gains
Gmail + Companion pairing; Settings (notifications, 2FA, billing); public
Terms/Privacy pages.

## 6. Policy & authority additions

- New grant `contact_executive` (authorized class, default on).
- New action kinds `draft_chargeback`, `draft_complaint` → always
  `USER_APPROVAL_REQUIRED`; the system can never file them.
- `send_attachment` requires `share_evidence`.
- Companion insert is a customer action; the agent cannot press send.
- Non-expansion guarantee unchanged: merchant text and model output still
  only flow through `classifyAction`.

## 7. Testing plan (local — repo has no CI)

- Vitest (workers pool): classifier fixtures (≥5 real-world examples per
  class), escalation ladder progression, deadline scheduling, forward
  intake parsing, attachment MIME build, OAuth token refresh (mocked),
  billing webhook signature, email-verification gating, policy tests for
  new kinds.
- Test Merchant scenarios added: `deflection`, `stonewall`,
  `channel_redirect`, `autoreply_only`, `bounce`.
- Clean-checkout proof per PR: `git worktree add --detach` + `npm ci` +
  typecheck + test + build.
- Prod verification per milestone as listed in each acceptance block;
  UI flows recorded.

## 8. Dogfood window

- Starts when M1–M4 are on prod. Anthony routes every real
  return/package/refund issue through the product for 30 days
  (target ≥10 cases; friends/family OK).
- Scoreboard = `/results`. Go/no-go for public launch:
  **≥60% of cases RECEIVED**, median customer time < 10 min/case, zero
  policy violations, and Anthony would pay the M8 price.

## 9. Ship gates (all required)

1. M1–M9 acceptance criteria met on prod.
2. Dogfood thresholds in §8 met.
3. ≥15 launch merchants with a VERIFIED lane; all others honestly labeled.
4. Security review: injection suite with live model, tenant isolation,
   companion permission audit, OAuth token handling, no secrets in logs.
5. Terms/Privacy/disclaimer live; Chrome Web Store listing approved.
6. Backup + restore drill passed; error alerting fires on a forced error.
7. `V1_LIMITATIONS.md` rewritten to the shipped boundary — nothing claimed
   that wasn't observed.

## 10. Decisions needed from Anthony

1. **Model provider for M1** — OpenAI or Anthropic (platform key as worker
   secret).
2. **Google Cloud OAuth app** under Anthony's account for Gmail send.
3. **Pricing** — 20% of recovered (cap $50), first case free? Or flat fee.
4. **Launch merchant list** — confirm or edit the 25 in M6.
5. **Chrome Web Store developer account** ($5 one-time) for M5.
6. **Stripe account** for M8.

## 11. Explicitly out of V1

Phone/voice calls; autonomous chat sending; cloud-hosted browsers; storing
merchant passwords or cookies; filing chargebacks/complaints for the
customer; non-retail categories (airlines, telecom, utilities,
subscriptions, travel, warranties, bill negotiation); non-US merchants;
Safari/Firefox extensions; mobile apps.
