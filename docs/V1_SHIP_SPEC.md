# V1 Ship Spec — from verified foundation to shipped product

Status: **DESIGNED** (nothing in this document is built unless it says
"exists today"). Channels in scope: **email + chat + web forms**. Phone/voice
is explicitly out of V1 and starts only after V1 ships.

This revision folds in every binding fix from
[V1_SHIP_SPEC_REDTEAM.md](V1_SHIP_SPEC_REDTEAM.md) (R1–R21). Where this
document and the red-team findings conflicted, the red-team fix won; the
red-team file is kept as the review record.

## 0. Definition of "V1 shipped"

V1 is shipped when a stranger can sign up at
`company-service.agentmasterkey.com`, open a post-purchase case against any
of the launch merchants by typing or forwarding an email, and Company Service
works it over email, assisted chat, and assisted web forms — escalating past
deflection — until the money is **RECEIVED (document-verified)** or the case
is honestly closed, with the customer only touching it for approvals and
chat/form sends. Every ship gate in §9 must be green.

## 1. Where we are (exists today, VERIFIED unless noted)

| Area | State |
|---|---|
| Auth, sessions, CSRF, tenant isolation | VERIFIED (no email verification / reset / 2FA yet) |
| Case intake → objective draft → mandate grant | VERIFIED |
| Policy engine, approvals, prohibited set | VERIFIED |
| Honest outcome ladder `REQUESTED…VERIFIED_RESOLVED` | VERIFIED — M4 splits `RECEIVED` by evidence source |
| Evidence upload to R2 (allowlist, 10 MB, SHA-256) | VERIFIED |
| Inbound email: Email Routing `cases@` → `email()` | VERIFIED on prod |
| Outbound email: `MAILOUT` `send_email` binding | VERIFIED on prod |
| Case threading (`case+token@`, `[CS-token]`, In-Reply-To) + dedup | VERIFIED |
| Assisted chat lane (draft → "I sent it" → paste reply) | VERIFIED (manual copy/paste) |
| Follow-ups (D1 + `*/5` cron), pause/revoke/cancel | VERIFIED |
| Export / delete-account / credential wipe | VERIFIED |
| Chewy email lane (contact + reply ingest) | VERIFIED (no resolution yet) |
| Merchant channel audit, 25 launch merchants | DONE — see `MERCHANT_CHANNEL_AUDIT.md` |
| OpenAI / Anthropic / compatible providers | IMPLEMENTED, NOT LIVE-VERIFIED — all verified flows use `local_dev` |
| Gmail `gmail.send` transport | IMPLEMENTED, NOT LIVE-VERIFIED (no OAuth flow) |
| Outbound attachments, notifications, billing, observability | NOT IMPLEMENTED |
| Staging environment | NOT IMPLEMENTED — built before M1 (R10) |

Key audit finding (R6): **only 4 of 25 launch merchants publish a support
email** (Chewy, Zappos, Sephora, Shein); 5 publish web contact forms; all 25
offer chat. The chat lane is therefore the critical path to the
≥15-VERIFIED-lane ship gate, and build order puts M5 right after M3.

## 2. Milestones

Build order (amended by R6/R10 — chat companion immediately after
escalation, staging before everything):

`staging env → M1 → M3 → M5 → M2 → M4 → M7 (+ abuse controls) → M6 → M9 → M8 → beta → ship gates`

| # | Milestone | Depends on | Est. |
|---|---|---|---|
| — | Staging environment + release checklist (R10) | refreshed API path via d10a | 0.5 session |
| M1 | Real reasoning (live model provider) | API key, staging | 0.5 session |
| M3 | Escalation engine (beat deflection) | M1 | 1 session |
| M5 | Chat companion extension (generic mode first) | M1, M3 | 2.5–3 sessions (R9) + Chrome Web Store review calendar |
| M2 | Email lane complete | M1 | 1 session + Google verification calendar (not launch-blocking) |
| M4 | Results & verification of money | M2 | 0.5 session |
| M7 | Account, trust, legal & abuse controls | — | 1 session |
| M6 | Merchant directory (25 launch merchants) | M2, M5 | 1 session (audit already done) |
| M9 | Ops & reliability | — | 1 session |
| M8 | Billing | M4, Stripe account | 0.5 session |
| — | Beta window (20–50 users) | M1–M5, M7 | 4–8 weeks calendar (R7/R8/R20) |
| — | Public launch | §9 gates | — |

Realistic total: **~9–11 sessions + 4–8 weeks of calendar time** (R20).
The calendar blockers — Google OAuth verification (weeks), Chrome Web Store
review (days–weeks), lawyer template review, beta recruitment — start early
and run in parallel. One milestone = one PR (or a small stack).

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
- **Abuse/cost gate (R12):** the account email must be verified before
  **any** platform-key model call (not just before sends); per-user daily
  and global daily spend caps as a hard stop + alert to Anthony; Cloudflare
  Turnstile on signup. Unverified accounts may only use `local_dev`-style
  deterministic intake — no live model calls at all.
- `local_dev` stays the test provider; CI-free test suite keeps using it.

**Acceptance:** a prod case on a real merchant is planned and drafted by the
live provider; `/economics` shows non-zero real cost; injection tests
(Scenario C) still pass with the live provider in a local run; an
unverified-email account is refused a model call on prod.

## M2 — Email lane complete

### 2.1 Send from the customer's own address (Gmail OAuth + forwarding filter)

- Google OAuth app (Testing mode, ≤100 test users until verification).
  Scopes: `gmail.send` only for V1. Reply ingestion stays on `cases@` via
  `Reply-To`/CC so we never need inbox-read scopes.
- `/connections` → "Connect Gmail" → OAuth → encrypted refresh token in
  `connections.config_enc`; refresh-on-401; revoke wipes it (exists).
- Outbound when connected: `From: customer@gmail.com`,
  `Reply-To: case+token@…`, `CC: case+token@…` so merchant replies-all land
  in the case. Transport precedence already prefers Gmail.
- **Forwarding-filter step (R1):** ticketing systems often answer the `From`
  address and drop `Reply-To`/CC, so replies can stall in the customer's
  Gmail where we can't read them. At connect, walk the customer through
  creating a **Gmail forwarding filter** (from the merchant domains in the
  registry → forward to `cases@` with the customer's case token where
  possible). Gmail sends a confirmation code to `cases@`; we ingest it and
  show it to the customer to complete the filter. The Gmail lane counts as
  working only after a merchant reply is actually observed in the case —
  otherwise it stays `CONTACT_CONFIRMED` with a "no reply in N days → check
  your inbox / re-forward" prompt.
- **Agent identity (R17):** Gmail-sent mail is in the customer's name, so
  every outbound message carries an honest signature disclosure —
  "sent with the help of Company Service" — and never pretends to *be* the
  customer beyond what the customer reviewed and approved.
- Fallback when not connected: `MAILOUT` from `case+token@` on the
  **dedicated sending subdomain** (see 2.5) with a signed "on behalf of
  <customer name>, account email <x>" line. Gmail is the **default** lane;
  MAILOUT is the fallback, not the reverse (R5).
- Google verification (sensitive scope) submitted before public launch;
  launch is not blocked on it if the MAILOUT fallback is acceptable.
- **Verify before reliance:** confirm Cloudflare `send_email` limits and
  acceptable-use terms for third-party recipients at volume (R5); a single
  successful send to `service@chewy.com` does not document the caps.

### 2.2 Forward-to-start intake

- Customer forwards an order/shipping/refund email to `cases@` (no token)
  from their **verified account email** → new DRAFT case for that user,
  **only if** the Email Routing authentication results show SPF or DKIM
  pass with DMARC alignment for the sender domain (R14). Otherwise no case
  is created; a confirm-by-link email goes to the account address and the
  case opens only after the account holder clicks it (signed in).
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

### 2.5 Deliverability & dedicated sending subdomain (R5/R19)

- Move all outbound — case mail **and** transactional notifications — to a
  dedicated subdomain `cases.agentmasterkey.com` (`case+token@cases.…`,
  `notify@cases.…`), so one merchant's spam complaint or blocklist hit
  cannot take out the whole fleet or the apex domain's reputation.
  `cases@agentmasterkey.com` remains the forward-to-start intake.
- Attach a signed **authorization letter** to the first outbound message:
  customer name, account email, order reference, scope of authorization —
  counters merchants' "we can only discuss this with the account holder"
  refusal.
- Verify SPF/DKIM/DMARC on the subdomain (`p=quarantine` minimum); doc in
  `EMAIL_ARCHITECTURE.md`.
- Monitor bounces and complaints **per merchant**; feed coverage `health`.
- Per-merchant throttle scoped to **unsolicited email follow-ups only**
  (max 1 / case / 24 h) — replies, escalation sends, and chat/form traffic
  are exempt (R15).

**Acceptance:** (a) real case sent from Anthony's Gmail with a merchant
reply observed in the case (forwarding filter proven end-to-end); (b)
forwarded order email creates a correct DRAFT; (c) photo attachment
received by a real merchant mailbox (send to a test inbox we control is
acceptable); (d) each classifier class covered by tests with fixture
emails; (e) outbound observed from the `cases.agentmasterkey.com`
subdomain with SPF/DKIM passing.

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
| 5 | **Draft** a card-dispute letter — template-only | approval — customer files it |
| 6 | **Draft** regulator/complaint letters — template-only | approval — customer files it |

**Rungs 5–6 are template-only, rebuilt from structured case facts (R3):**

- The documents are rendered from `case_claims` (claims with provenance),
  the timeline, and the evidence bundle by **fixed templates** — never
  free-form model text. Merchant message text is **not an input** to these
  drafts, so a prompt-injected merchant reply cannot steer a complaint
  into false statements made in the customer's name.
- Correct legal framing: **FCBA** covers goods not delivered / not
  accepted and runs a **60-day clock from the statement that first showed
  the charge**; "not as described" usually goes through **card-network
  chargeback rules** instead. For **debit** cards the draft says
  "card-issuer dispute (network rules)" — **no Reg E citation** (Reg E
  covers EFT errors, not merchant refund disputes). The template states
  which track applies, or says neither and lets the bank decide.
- **CFPB** complaints are gated on financial-product issue types only —
  wrong for retail cases. Other templates: FTC ReportFraud, state AG
  consumer-protection, BBB.
- Drafts state facts and the customer's request, link out to official
  guidance pages, never predict outcomes, and carry a reviewed
  "not legal advice" disclaimer. **One-time lawyer review of the template
  set is a ship gate** (R3).
- The customer files everything themselves; the system never files, and
  policy tests prove rungs 5–6 can never auto-send.
- Evidence bundle: one generated PDF (timeline, messages, receipts,
  promises vs dates) stored as `case_evidence` kind `pdf`.

### 3.3 Deadline tracker

- New `case_deadlines` rows: merchant return window, promised-by date,
  chargeback window (60 days from statement date), complaint windows.
- **Deadlines need source data (R18):** the chargeback window needs the
  statement date, which we don't have — prompt the customer for it and
  label the deadline `CUSTOMER_STATED`; merchant-quoted dates label
  `MERCHANT_STATED`; nothing presents a computed deadline as authoritative.
- Cron surfaces `FOLLOW_UP_DUE` 7 and 2 days before each.

**Acceptance:** Test Merchant gains scripted `deflection` and
`stonewall` scenarios; a sim case climbs rungs 1→5 automatically, stops at
rung 5 with an approval card, and the chargeback draft + evidence PDF
render correctly. Policy tests prove rungs 5–6 can never auto-send and
that merchant text never reaches the templates.

## M4 — Results & money verification

- **Confirm receipt:** when outcome reaches `ISSUED`/`PROMISED`, schedule a
  check at the promised date: customer gets "Did $X arrive?" (yes / no /
  partial amount).
- **`RECEIVED` splits by evidence source (R4):**
  - `RECEIVED (CUSTOMER_CONFIRMED)` — customer answered yes.
  - `RECEIVED (DOCUMENT_VERIFIED)` — a forwarded refund-confirmation email
    or bank-statement screenshot parsed and stored as evidence.
  - `VERIFIED_RESOLVED` **requires document-verified** money plus customer
    confirm of the overall resolution. Customer self-report alone never
    reaches the top tier — under contingency billing the customer has a
    direct incentive to answer "no," so self-report is not verification.
- New per-case fields (`cases.meta.results`): `amount_claimed`,
  `amount_recovered`, `customer_minutes` (self-reported at close),
  `agent_messages_sent`, `days_to_resolution`, `escalation_max_rung`,
  plus **starting state** (R8): `days_overdue_at_start`,
  `prior_customer_attempts`, `refund_already_in_progress` (feeds M8
  attribution).
- `/results` page (and owner-only `/admin/results`): recovery rate,
  $ recovered, median days, **by merchant and by lane**, and outcomes
  counted **after an escalation rung** (not just raw RECEIVED) so we can
  see what the product actually added (R8).

**Acceptance:** one real case closes `VERIFIED_RESOLVED` on a
document-verified receipt with `amount_recovered > 0` and appears on
`/results`; a customer-confirmed-only case is shown honestly below the
top tier.

## M5 — Chat companion (browser extension)

Implements BROWSER_ARCHITECTURE Option B. The customer's own Chrome, their
own logged-in merchant session; **the customer clicks send** in V1.

### 5.1 Extension (Manifest V3, Chrome first) — generic mode first (R9)

- **Generic mode ships first:** the user highlights the chat region once;
  the extension reads **text only** from it (and from the page's visible
  chat stream). Per-merchant DOM selector configs
  (`company_coverage.meta.chat_selectors`) ship later as an optimization —
  selector drift is ongoing maintenance, and the M6 cron gains a
  **selector-health check** that flips stale selectors to `degraded`.
- Pair with account via short code from `/connections` → scoped token
  (per-user, revocable, stored in `connections`).
- Side panel opens when the active tab matches a merchant chat URL from the
  coverage registry (allowlist only; no activity elsewhere).
- Merchant chat widgets commonly run in **cross-origin iframes** from
  vendor domains (LivePerson, Salesforce, Sprinklr, Zendesk): the
  extension needs `all_frames` plus host permissions for those vendor
  domains — widened permissions are called out in the listing copy and the
  security review.
- **Text-only rendering:** transcript and draft content are rendered as
  text in the side panel — never HTML — closing the untrusted-HTML/XSS
  hole in a privileged extension.
- Shows the agent's drafted next message; buttons: **Insert** (places text
  into the chat input — does not press send), **Regenerate**, **I sent it**.
- Streams new merchant messages to `/api/cases/:id/assisted/reply`
  automatically (exists as manual paste today) → classifier (M2.4) →
  deflection → next draft comes from the escalation ladder (M3).
- End-of-chat wrap-up: draft asks for reference number + transcript email;
  saves full transcript as `case_evidence` (kind `email`/`note`) with
  SHA-256; optional visible-tab screenshot as evidence.
- **Form-channel assist:** on `form` lanes the extension can prefill the
  drafted text into the merchant's web contact form; the customer submits.
- No credential access, no cookie export, no CAPTCHA interaction, no
  auto-send, no background tabs. Permissions: `sidePanel`, `activeTab`,
  `storage`, host permissions only for allowlisted support domains plus
  the chat-vendor iframe domains.

### 5.2 Server

- `GET /api/companion/context?url=` → matched case + current draft.
- `POST /api/companion/pair`, `/revoke`.
- Rate-limit + audit every companion call.

### 5.3 Distribution

- Chrome Web Store listing (unlisted for beta, public at launch). Store
  review takes days–weeks and "reads pages + AI" listings get extra
  scrutiny — submit early; it's a calendar blocker, not a code blocker
  (R9/R20).
- Safari/Firefox: post-V1.

**Acceptance:** in generic mode on 3 real merchant chats (e.g. Amazon,
Walmart, Target) the transcript is captured live, drafts appear, a
deflection triggers an escalation draft, and the transcript lands in the
case — recorded on video.

## M6 — Merchant directory (launch set)

- 25 US merchants, each a `companies` row + `company_coverage` rows per
  channel + a **playbook** (`merchant_playbooks` table):
  `support_email`, `chat_url`, `chat_selectors`, `form_url`,
  `executive_contact`, `return_window_days`, `policy_url`,
  `policy_quotes[]`, `known_deflections[]`, `what_works[]`,
  `last_verified_at`.
- **Channels:** `email`, `chat`, `form` (new), `phone` (out of V1 scope —
  informational only). `form` lanes are ASSISTED: agent drafts → customer
  pastes/submits (extension can prefill, M5).
- Seed via idempotent `INSERT OR IGNORE` per row (never early-return seed).
- Launch set per `MERCHANT_CHANNEL_AUDIT.md` — audit already done: 4 email
  lanes, 5 form lanes, 25 chat lanes confirmed on official sites.
- **Verification labels (R7):** `UNVERIFIED` → `CONTACT_CONFIRMED` (route
  confirmed on the official site — what this audit produces) → `VERIFIED`
  (a real customer case observed working through that lane). Lanes become
  VERIFIED **only from real cases** — never by sending test inquiries to
  real merchants, which would be `submit_false_statement`-class spam.
- Monthly health check (cron): bounced emails / changed chat URLs / stale
  `chat_selectors` flip `health` → `degraded`.

**Acceptance:** all 25 rows seeded `CONTACT_CONFIRMED` from the audit;
≥15 merchants reach `VERIFIED` on at least one lane **from real cases**
during beta before launch; the rest stay honestly labeled.

## M7 — Account, trust, legal & abuse controls

- Email verification on signup — required before **any** platform-key
  model call (R12), before any outbound send, and before forward-to-start
  trusts the sender.
- Password reset via emailed one-time link (transactional subdomain).
- TOTP 2FA (optional, encouraged).
- Notifications (transactional subdomain `cases.agentmasterkey.com` —
  R19; preferences page): merchant replied, approval needed, deadline in
  2 days, money check-in, case resolved.
- Guided first case on empty dashboard (forward-an-email or type).
- Public pages: Terms (ban false claims; termination for them), Privacy
  (with a **data map**), "How it works / what we never do", "Not legal
  advice" disclaimer; consent checkbox at signup.
- **Retention (R16):** auto-purge of evidence N days after case close
  (configurable, default 90); honor state privacy-law requests
  (export/delete exist); retention rules written into Privacy.
- **Abuse controls:** see §11 — attestation before first send and before
  any rungs-5/6 draft, one case per order, pattern limits, evidence
  requirements for `missing_item`/`damaged_item`, fraud-signal review
  queue, max 10 active cases/user, outbound content checks
  (`submit_false_statement` already prohibited), report-abuse inbox.
- **Support path for our customers (R21):** a support inbox for Company
  Service users, plus `/admin` read-only case inspection for Anthony with
  per-view audit logging (customer consent recorded).

## M8 — Billing

- Stripe Checkout + webhook (worker), customer stored as
  `connections` type `billing`.
- **Card on file at mandate grant** with a clear fee preview before the
  customer authorizes the first send (R13) — charging after resolution
  with no card means low collection.
- Pricing (to confirm, see §10): first case free; then **20% of
  `amount_recovered`**, capped at $50/case, charged only on document-
  verified or card-backed customer-confirmed `RECEIVED`; $0 if nothing
  recovered. Optional flat $5 for non-monetary outcomes (replacement
  delivered).
- **Attribution rules (R13):** no fee if the refund was already in
  progress at case start (from M4's starting-state fields); money
  recovered through a **customer-filed chargeback** is excluded from the
  percentage fee or moved to a small flat fee — charging a share of a
  self-filed dispute is contentious. Beta alternative to evaluate: flat
  $5–10/case to learn willingness to pay.
- Invoice shows the evidence that money was received.

## M9 — Ops & reliability

- **Staging environment (R10, built first):** `company-service-staging`
  worker + D1 + R2 on the same account; deploys scripted through the d10a
  multipart upload path; every prod deploy follows the release checklist
  below.
- **Release checklist:** clean-checkout gates (`git worktree` + `npm ci` +
  typecheck + test + build) → staging deploy + smoke → prod deploy +
  smoke (hard-refresh the SPA — content-hashed bundles) → keep the
  previous bundle as the rollback artifact.
- Cloudflare Workflows for long-running cases (weeks of waiting) with cron
  kept as sweeper; Queues for inbound bursts.
- Error tracking: Sentry (or Workers Logpush → R2) with alert to Anthony.
- Cloudflare rate limiting rules on auth + companion endpoints.
- Daily D1 export to R2 (backup) + restore drill documented.
- Status row stays in Mission Control (exists).
- Move SPA from inlined `src/static.ts` to Workers Assets if a credential
  with assets-upload rights becomes available (nice-to-have).

---

## 3. Data model changes (migration `0004_v1_ship.sql`, additive only)

Named `0004` to avoid colliding with the previously added-then-deleted
`0003` (R11). Verified 2026-10-06: prod has **no `d1_migrations` table**
(migrations were hand-applied via d10a), so no recorded `0003` exists —
but `0004` keeps the numbering unambiguous. Every statement is idempotent
(`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`); no new FKs onto
existing rows. Apply to staging first, then prod via the d10a D1 query,
then `seedRegistry` per-row upserts.

| Table / column | Purpose |
|---|---|
| `users.email_verified_at`, `users.totp_secret_enc` | M7 |
| `password_resets` (token_hash, expires_at) | M7 |
| `notification_prefs` (user_id, kind, enabled) | M7 |
| `case_escalations` (case_id, rung, action_id, status, at) | M3 |
| `case_deadlines` (case_id, kind, due_at, source, status) | M3 — `source` ∈ `CUSTOMER_STATED`/`MERCHANT_STATED`/computed |
| `merchant_playbooks` (company_id, fields per M6, version) | M6 |
| `companion_pairings` (user_id, token_hash, created_at, revoked_at) | M5 |
| `billing_events` (case_id, amount, stripe_id, status) | M8 |
| `fraud_signals` (case_id, user_id, kind, detail, status, created_at) | §11 review queue |
| `attestations` (case_id, user_id, scope, text_version, at) | §11 attestation records |
| `external_messages.meta.classification` (JSON, no DDL) | M2.4 |
| `cases.meta.results` (JSON incl. starting state, no DDL) | M4 |
| `company_coverage.channel` gains `form`; `company_coverage` gains `verification_tier` (`UNVERIFIED`/`CONTACT_CONFIRMED`/`VERIFIED`) | M6 |

## 4. New / changed API

`POST /api/auth/verify-email`, `POST /api/auth/reset/request`,
`POST /api/auth/reset/confirm`, `POST /api/auth/totp/*`,
`GET/POST /api/connections/gmail/oauth/{start,callback}`,
`POST /api/connections/gmail/forwarding-status`,
`GET /api/companion/context`, `POST /api/companion/{pair,revoke}`,
`POST /api/cases/:id/received` (money check-in, with evidence option),
`POST /api/cases/:id/attest`, `GET /api/cases/:id/bundle.pdf`,
`GET /api/results`, `GET /api/admin/cases/:id` (read-only, audit-logged),
`GET /api/admin/fraud-queue`,
`POST /api/billing/{checkout,webhook}`, `GET/PUT /api/notifications`.
All behind existing session + CSRF + tenant checks, except: companion
endpoints use the pairing token, and `POST /api/billing/webhook` is
session/CSRF-exempt and authenticated only by Stripe signature verification
(`Stripe-Signature`, raw body, timestamp tolerance, idempotent on event id);
the OAuth `callback` is session-bound via a signed `state` parameter.

## 5. UI changes

Dashboard empty-state onboarding; case detail gains **Escalation** rail
(rung, next step, deadlines with their source labels), **Money** card
(claimed / promised / received + which `RECEIVED` tier), attestation
checkbox moments, chargeback/complaint draft viewer; Gmail connect wizard
with the **forwarding-filter step**; `/results`; Connections gains Gmail +
Companion pairing; Settings (notifications, 2FA, billing, retention); a
support link; `/admin` read-only views + fraud queue; public
Terms/Privacy pages.

## 6. Policy & authority additions

- New grant `contact_executive` (authorized class, default on).
- New action kinds `draft_chargeback`, `draft_complaint` → always
  `USER_APPROVAL_REQUIRED`; the system can never file them; rendered by
  fixed templates from structured case facts only — merchant text and
  free-form model text are not inputs (R3).
- `send_attachment` requires `share_evidence`.
- `form` channel sends are ASSISTED customer actions, same as chat.
- Companion insert is a customer action; the agent cannot press send.
- Agent-identity rule: outbound never pretends to *be* the customer beyond
  what they reviewed and approved; Gmail-lane mail carries the
  "sent with the help of Company Service" disclosure (R17).
- Non-expansion guarantee unchanged: merchant text and model output still
  only flow through `classifyAction`.

## 7. Testing plan (local — repo has no CI)

- Vitest (workers pool): classifier fixtures (≥5 real-world examples per
  class), escalation ladder progression, deadline scheduling,
  forward-intake parsing + SPF/DKIM/DMARC gating, attachment MIME build,
  OAuth token refresh (mocked), Gmail forwarding-code ingestion, billing
  webhook signature, email-verification-before-model-call gating, abuse
  pattern limits, template renderers, policy tests for new kinds.
- Proof that rungs 5–6 templates cannot ingest merchant text and can never
  auto-send.
- Test Merchant scenarios added: `deflection`, `stonewall`,
  `channel_redirect`, `autoreply_only`, `bounce`.
- Clean-checkout proof per PR: `git worktree add --detach` + `npm ci` +
  typecheck + test + build.
- Staging smoke → prod verification per milestone as listed in each
  acceptance block; UI flows recorded.

## 8. Beta & dogfood window (revised — R7/R8)

- Starts when M1–M5 and M7 abuse controls are on prod. Anthony dogfoods
  first; then a **20–50 user beta** (friends/family/recruited) before
  public launch — the ≥15-VERIFIED-lane gate is only realistic with beta
  volume, since lanes verify from real cases only.
- Each case records **starting state** (days overdue, prior customer
  attempts, refund already in progress) so "60% RECEIVED" isn't measuring
  what would have happened anyway.
- Scoreboard = `/results`, reported **per lane** (email / chat / form):
  recovery rate, $ recovered, median days, outcomes **after an
  escalation rung**, minutes saved vs the customer's estimate.
- Go/no-go for public launch: **≥60% of cases RECEIVED** (document-
  verified or card-backed customer-confirmed) **per active lane**, median
  customer time < 10 min/case, zero policy violations, zero unresolved
  fraud-queue items, and Anthony would pay the M8 price.

## 9. Ship gates (all required)

1. M1–M9 acceptance criteria met on prod.
2. Beta thresholds in §8 met (per lane).
3. ≥15 launch merchants with a **VERIFIED-from-real-cases** lane; all
   others honestly labeled `CONTACT_CONFIRMED`/`UNVERIFIED`.
4. **Abuse controls live** (§11): attestation, one-case-per-order,
   pattern limits, evidence requirements, fraud queue, Terms language.
5. **Lawyer review of the rungs-5/6 template set** completed (R3).
6. Security review: injection suite with the **live** model, tenant
   isolation, companion permission audit (`all_frames` scope justified,
   text-only rendering), OAuth token handling, no secrets in logs.
7. Terms/Privacy/disclaimer live; Chrome Web Store listing approved.
8. Staging environment in use; backup + restore drill passed; error
   alerting fires on a forced error.
9. `V1_LIMITATIONS.md` rewritten to the shipped boundary — nothing
   claimed that wasn't observed.

## 10. Decisions needed from Anthony

1. **Model provider for M1** — OpenAI or Anthropic (platform key as worker
   secret `PLATFORM_MODEL_KEY`).
2. **Google Cloud OAuth app** under Anthony's account for Gmail send
   (Testing mode; verification submitted early — it's a weeks-long
   calendar blocker).
3. **Pricing** — 20% of recovered (cap $50, card on file, attribution
   rules in M8)? Or flat $5–10/case during beta.
4. **Launch merchant list** — confirm or edit the 25 (audit done).
5. **Chrome Web Store developer account** ($5 one-time) for M5 — create
   early; listing review is a calendar blocker.
6. **Stripe account** for M8.
7. **Lawyer** for the one-time rungs-5/6 template review (ship gate 5).
8. **Beta recruitment** — 20–50 users from friends/family/audience.

## 11. Abuse & fraud controls (new — R2)

A product that pushes merchants to refund "item not received" claims,
escalates automatically, and drafts chargebacks is also a friendly-fraud
tool at scale. These controls ship with M7 and are ship gate 4:

- **Attestation:** the customer attests to the facts (recorded in
  `attestations` with the text version) before the first outbound send and
  again before any rungs-5/6 draft is generated.
- **One case per order:** enforced on order identifier + merchant.
- **Pattern limits per user:** claims per month, $ claimed per month,
  repeat merchants — breaches queue the account in `fraud_signals`.
- **Evidence requirements:** `missing_item`/`damaged_item` claims need a
  photo or carrier-status evidence before outreach.
- **Fraud-signal review queue:** `/admin` view; flagged cases pause
  outbound until reviewed.
- **Terms:** ban false claims; termination for them.
- **Domain reputation protection:** dedicated sending subdomain (M2.5),
  per-merchant bounce/complaint monitoring, outbound content checks —
  merchants blocklisting `agentmasterkey.com` kills every honest
  customer's lane.

## 12. Explicitly out of V1

Phone/voice calls; autonomous chat sending; cloud-hosted browsers; storing
merchant passwords or cookies; CAPTCHA bypass; filing
chargebacks/complaints for the customer; free-form model-drafted legal
documents; non-retail categories (airlines, telecom, utilities,
subscriptions, travel, warranties, bill negotiation); non-US merchants;
Safari/Firefox extensions; mobile apps.
