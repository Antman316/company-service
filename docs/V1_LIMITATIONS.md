# V1 Limitations

Everything not VERIFIED is listed here. Nothing aspirational is documented
elsewhere as built.

## Merchant coverage

- **No real merchant adapter is VERIFIED.** Test Merchant is SIMULATED;
  Amazon is registered MANUAL_HANDOFF/UNVERIFIED (email drafting + tracking
  only). Everything else → `UNSUPPORTED` + manual handoff.
- No browser/chat automation — ASSISTED only (see BROWSER_ARCHITECTURE).

## Model providers

- `openai`, `anthropic`, `openai_compatible` are IMPLEMENTED but NOT
  LIVE-VERIFIED (no API keys exist in the org; BYO-credentials via
  Connections is the path). `local_dev` powers all verified flows.

## Email

- `gmail.send` transport IMPLEMENTED, NOT LIVE-VERIFIED (needs a customer
  OAuth'd token; only `gmail.send` scope is used).
- **No inbound email routing** — `EMAIL_DOMAIN` is a placeholder; real
  merchant replies can't arrive yet. Inbound endpoint + threading + dedup are
  built and tested via the sim endpoint.
- No outbound attachments.

## Deploy/infrastructure

- `workers.dev` subdomain can't be enabled by the deploy credential (API
  10405) — public URL is the custom domain
  `company-service.agentmasterkey.com` on the WGU account zone.
- SPA is inlined into the worker bundle (`src/static.ts`), not Cloudflare
  Assets — functional, adds ~370 KB to the script; switch to `env.ASSETS`
  once a credential with assets-upload rights exists.
- Cloudflare Workflows/Queues not used — durability is D1 + 5-min cron.
  Workflows is the V1.1 upgrade for longer waits.
- R2 bound but evidence upload writes are exercised only in local dev paths
  (prod verified through metadata-only evidence; file upload path needs a UI
  pass against prod).

## Product

- No 2FA, no email verification, no password reset.
- Export/delete-account endpoints not shipped.
- Onboarding is signup → straight to dashboard; no guided first-case tour.
- Economics view is real but shows $0 local_dev costs until a paid provider
  is connected.

## Security

- Rate limiting is basic D1 counters.
- Error responses don't leak internals, but observability is `console.error`
  + `audit_events` — no Sentry/Logpush wired yet (`logpush: false`).
