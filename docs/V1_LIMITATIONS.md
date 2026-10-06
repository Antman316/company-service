# V1 Limitations

Everything not VERIFIED is listed here. Nothing aspirational is documented
elsewhere as built.

## Merchant coverage

- **25-merchant launch directory (M6) IMPLEMENTED** — every launch merchant
  has a `companies` row, a MANUAL_HANDOFF floor lane, per-channel coverage
  lanes, and a `merchant_playbooks` row. Per the channel audit
  (`MERCHANT_CHANNEL_AUDIT.md`): 4 publish a support email (Chewy, Zappos,
  Sephora, Shein), 5 publish a web form, 24 publish a chat lane. Every lane
  address carries its official-source URL in `notes`.
- **Lane labels are honest:** `CONTACT_CONFIRMED` = the channel is
  confirmed on the merchant's official site but no real customer case has
  used it yet. `VERIFIED` = a real merchant reply was observed through
  that lane (promoted automatically from CONTACT_CONFIRMED/UNVERIFIED when
  a reply lands — never downgraded). Today only **Chewy + email** is
  VERIFIED (real outbound mail `service@chewy.com`, prod case
  `case_muunvdukh1f5pmklq3`, 2026-10-05). Ship gate ≥15 VERIFIED lanes is
  **NOT MET** — it requires real cases, not seeding.
- **SIMULATED lanes (Test Merchant) can never become VERIFIED** — sim
  traffic is not real contact; the promotion only upgrades
  CONTACT_CONFIRMED/UNVERIFIED rows.
- **Monthly lane-health check IMPLEMENTED, UNVERIFIED** — the 5-min sweep
  runs `runDirectoryHealthCheck` at most once per 30 days: email lanes
  degrade on `send_bounced`/`delivery_failed` audit rows in the last 30d;
  chat/form lanes degrade when the official URL stops answering. Flips
  write `lane_health_change` audits. UNVERIFIED: the first real monthly
  run has not happened yet.
- Playbook fields `executive_contact`, `policy_quotes`, `chat_selectors`
  start empty/null per lane — nothing is fabricated; verified contacts
  land in playbooks as real cases produce them.
- No autonomous browser/chat automation — ASSISTED is the shipped lane
  (see BROWSER_ARCHITECTURE). No CAPTCHA bypass, no credential storage.

## Email

- **Inbound route VERIFIED on prod** (real MX-transit message → Email
  Routing `cases@` literal rule → `email()` handler → case-token/subject-tag
  resolution → dedup → UNTRUSTED ingest → case wake — 2026-10-05).
- **Outbound VERIFIED on prod via `send_email` binding** — real mail to
  `service@chewy.com`, transport `cloudflare_send_email`, stamped Message-ID
  threaded for replies. Resend transport stays IMPLEMENTED (unverified,
  optional fallback); `gmail.send` remains the customer-OAuth alternative.
- No outbound attachments.

## Model providers

- `openai`, `anthropic`, `openai_compatible` are IMPLEMENTED but NOT
  LIVE-VERIFIED (no API keys exist in the org; BYO-credentials via
  Connections is the path). `local_dev` powers all verified flows.

## Deploy/infrastructure

- `workers.dev` subdomain can't be enabled by the deploy credential (API
  10405) — public URL is the custom domain
  `company-service.agentmasterkey.com` on the WGU account zone.
- `secret:org:CLOUDFLARE_API_TOKEN` is expired for direct REST calls —
  deploys go through the Cloudflare d10a MCP (multipart script upload,
  base64 staged in a D1 `deploy_stage` table for >~600 KB bundles).
- **Staging environment VERIFIED 2026-10-06** — `company-service-staging`
  worker at https://cs-staging.agentmasterkey.com with its own D1
  (`company-service-db-staging`) + R2 (`company-service-evidence-staging`);
  `ENVIRONMENT=staging` keeps sim endpoints enabled. Every prod deploy
  follows `docs/RELEASE_CHECKLIST.md`.
- SPA is inlined into the worker bundle (`src/static.ts`), not Cloudflare
  Assets — functional, adds ~370 KB to the script; switch to `env.ASSETS`
  once a credential with assets-upload rights exists.
- Cloudflare Workflows/Queues not used — durability is D1 + 5-min cron.
  Workflows is the V1.1 upgrade for longer waits.
- ~~R2 evidence upload not prod-verified~~ — **done**: real file upload
  verified on prod (size cap, MIME allowlist, randomized keys, per-user
  authz, `Content-Disposition: attachment` + nosniff, SHA-256 preserved).

## Product

- **Escalation engine IMPLEMENTED on `local_dev` (M3, sim-verified) — NOT
  VERIFIED on prod.** Deflection detection (empathy-without-action,
  policy-wall without citation, repeat non-answer, past-deadline promise)
  drives a six-rung ladder: 1 restate+cite policy → 2 human/reference →
  3 supervisor + 5-business-day deadline → 4 executive contact (playbook) →
  5 card-dispute draft → 6 regulator-complaint drafts. Rungs 5–6 are
  template-only from case records (merchant text is never an input), always
  approval-gated, and the customer files the documents — the system never
  files. No real-merchant escalation has run yet; Test Merchant `deflection`
  + `stonewall` scenarios cover the climb in Vitest.
- Evidence bundle PDFs are generated records (timeline + message log +
  provenance-labeled claims + SHA-256 exhibit list), not legal documents.
- Chargeback wording is deliberately honest: FCBA cited only for
  credit-card goods-not-delivered cases; debit/unspecified → card-issuer
  dispute under network rules. No Reg E claims for merchant disputes. The
  letter is not legal advice and is labeled as such.
- Case deadlines are source-labeled (CUSTOMER_STATED / MERCHANT_STATED /
  COMPUTED); the chargeback window needs a customer-entered statement date.
- **Chat companion (M5) IMPLEMENTED, NOT VERIFIED on real merchant chats.** The
  Chrome MV3 extension (`extension/`) pairs via short code → scoped revocable
  bearer token (`companion_pairings`), prefilters tabs against the domain
  allowlist fetched from `/api/companion/domains` (no calls leave for other
  sites), watches a user-picked region text-only, and streams observed text to
  the same UNTRUSTED ingest as pasted replies. It can fill the chat input but
  **never presses send**. Per-merchant selector configs are deferred — generic
  mode is the shipped mode. The spec's acceptance (3 real merchant chats on
  video) requires real customer accounts and is not yet met.
- Companion endpoints are rate-limited per pairing (120/min, 4000/day, counted
  from the audit trail) and every call writes an audit event.
- **Results & receipt tiers (M4) IMPLEMENTED.** `RECEIVED` splits by evidence
  source: `customer_confirmed` vs `document_verified` (outcome `evidence_note`
  carries it). `VERIFIED_RESOLVED` requires BOTH a document on file and the
  customer confirming resolution — self-report alone tops out at RECEIVED.
  A customer can still close a case on their word alone; it stays at the
  RECEIVED tier and is labeled as such everywhere. Partial receipts record
  partial amounts; a document that verifies already-confirmed money never
  double-counts (`amount_recovered` = max attested, additions are increments).
- `GET /api/results` is public but aggregate-only — merchants with fewer than
  3 cases merge into "other" so no single case is inferable; totals include
  SIMULATED cases (the caveat on the page says so). Owner-only per-case detail:
  `GET /api/admin/results` gated by the `ADMIN_EMAILS` binding.
- Document verification means "a document was stored on the case" — the amount
  is parsed from the document text when possible, else customer-entered; the
  parsed figure is not itself verified against a bank feed (no Plaid in V1).
- ~~No 2FA, no email verification, no password reset~~ — **done (M7)**:
  email verification (required before any real-channel outbound send and
  before forward-to-start trusts the sender), password reset via one-time
  mailed link, and optional TOTP 2FA are all implemented. System mail goes
  through MAILOUT→Resend→dev_log — it never uses a customer's case
  connection. Unverified accounts can still create cases and use the
  deterministic local intake; real sends + non-local model calls are gated.
- Spend caps (§11) IMPLEMENTED: per-case soft cap ($0.50 default → pause +
  approval to continue), per-user daily ($5), global daily ($100) — all in
  micro-USD env vars. They gate non-local model calls only; on `local_dev`
  spend is $0 and the gate is dormant (verified via a fake BYO connection
  in tests). Turnstile on signup is enforced only when `TURNSTILE_SECRET`
  is configured on the worker — provisioned 2026-10-06 on both envs.
- Abuse controls IMPLEMENTED: max 10 active cases/user (429), outbound
  content checks (threats, PAN-like digit runs, credential patterns →
  blocked + `fraud_signals` row), public `/api/abuse/report` inbox
  (rate-limited per reporter). Email verification is **not** an anti-fraud
  guarantee — it proves mailbox access, not identity.
- Legal surfaces IMPLEMENTED but NOT LAWYER-REVIEWED: Terms, Privacy,
  "How it works / what we never do", and "Not legal advice" pages are live
  at public hash routes, with a consent checkbox at signup
  (`tos_accepted_at`). The ship gate still requires a lawyer's pass on
  template + terms wording.
- Forward-to-start IMPLEMENTED: mail to `case+new@<domain>` from a
  verified account email creates a case; unverified or unknown senders
  are rejected. Spoofing a *from* header is easy — the case is created in
  the matched account, not the spoofer's, which limits the blast radius.
- ~~Export/delete-account endpoints not shipped~~ — **done**:
  `/api/account/export` (13-table dump) + `/api/account/delete`
  (R2 + full cascade incl. sessions), connection revoke wipes credentials,
  mandate revoke + pause/cancel — all verified on prod.
- ~~Onboarding is signup → straight to dashboard; no guided first-case tour~~
  — **done (M7)**: empty dashboard now offers both entries (forward an email
  to `case+new@…` or describe the problem), plus an email-verification
  banner until verified.
- Economics view is real but shows $0 local_dev costs until a paid provider
  is connected.

## Security

- Rate limiting is basic D1 counters.
- Error responses don't leak internals, but observability is `console.error`
  + `audit_events` — no Sentry/Logpush wired yet (`logpush: false`).
