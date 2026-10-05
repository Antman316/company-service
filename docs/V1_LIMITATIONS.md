# V1 Limitations

Everything not VERIFIED is listed here. Nothing aspirational is documented
elsewhere as built.

## Merchant coverage

- **First real merchant lane: Chewy + US + email** — `service@chewy.com`
  (official published support email). VERIFIED for initiating contact:
  real outbound mail sent through `cloudflare_send_email` (prod case
  `case_muunvdukh1f5pmklq3`, 2026-10-05). Replies ingest through the
  live Email Routing lane (inbound verified separately). Does NOT imply
  account access, order data, or guaranteed outcomes — those stay
  MANUAL. Everything else → `UNSUPPORTED` + manual handoff.
- Test Merchant remains SIMULATED; Amazon/Walmart/Target **chat** is
  ASSISTED (lane VERIFIED on prod; merchant contact itself not proven);
  Amazon email/portal remains UNVERIFIED.
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
  deploys go through the Cloudflare d10a MCP (multipart script upload).
- SPA is inlined into the worker bundle (`src/static.ts`), not Cloudflare
  Assets — functional, adds ~370 KB to the script; switch to `env.ASSETS`
  once a credential with assets-upload rights exists.
- Cloudflare Workflows/Queues not used — durability is D1 + 5-min cron.
  Workflows is the V1.1 upgrade for longer waits.
- ~~R2 evidence upload not prod-verified~~ — **done**: real file upload
  verified on prod (size cap, MIME allowlist, randomized keys, per-user
  authz, `Content-Disposition: attachment` + nosniff, SHA-256 preserved).

## Product

- No 2FA, no email verification, no password reset.
- ~~Export/delete-account endpoints not shipped~~ — **done**:
  `/api/account/export` (13-table dump) + `/api/account/delete`
  (R2 + full cascade incl. sessions), connection revoke wipes credentials,
  mandate revoke + pause/cancel — all verified on prod.
- Onboarding is signup → straight to dashboard; no guided first-case tour.
- Economics view is real but shows $0 local_dev costs until a paid provider
  is connected.

## Security

- Rate limiting is basic D1 counters.
- Error responses don't leak internals, but observability is `console.error`
  + `audit_events` — no Sentry/Logpush wired yet (`logpush: false`).
