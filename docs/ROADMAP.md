# Roadmap

## V1.1 — "one real workflow" (priority order)

1. **Real inbound email** — Cloudflare Email Routing on a real case domain →
   worker `email()` handler → `/api/email/inbound`. This is the single highest
   leverage piece: it turns the tested email loop into a real channel.
2. **First REAL VERIFIED merchant flow** — pick one retailer whose support is
   a public email address; register coverage `email/return_refund_pending`,
   run a real case end-to-end, mark it VERIFIED only after observed success.
3. **Gmail `gmail.send` OAuth connection** — Google OAuth consent for just the
   send scope; verify live; customers send from their own address.
4. **Evidence file upload on prod** — finish R2 path through the UI (upload,
   view, share-as-link); multipart upload endpoint already accepts files.
5. **Account export + delete** — cascade by user_id; audit event.

## V1.2 — reach

6. **Cloudflare Workflows** for waits >1 day and multi-step merchant
   sequences (cron stays as the cheap sweeper).
7. **Browser companion extension** per BROWSER_ARCHITECTURE (Option B).
8. **Real provider verification** — exercise openai/anthropic adapters with
   org keys; task-tiered routing (light vs strong models).
9. **Sentry/Logpush + alerting**, Cloudflare-native rate limiting.
10. **Stripe** — only after a real resolution exists to charge against.

## Later categories (explicitly not yet)

Airlines, telecom, utilities, subscriptions, delivery, travel, warranties,
bill negotiation — each needs its own coverage + adapter verification before
it's claimable. ACP/UCP/A2A/MCP-server exposure stays unimplemented until a
participating endpoint materially improves a real workflow (YAGNI).

## Success metric gates

- First VERIFIED_RESOLVED on a real merchant with real customer evidence.
- Operator-free rate measured on real cases (not demo).
- Direct cost per resolved case < price point that makes the model a business.
