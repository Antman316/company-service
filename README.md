# Company Service

**They have Customer Service. Now you have Company Service.**

An AI consumer-representation agent. You describe a post-purchase problem in
plain English — a refund that never arrived, a wrong or damaged item, a return
that went unanswered — and Company Service opens a durable case, collects
evidence, asks for a bounded mandate, contacts the company through the best
supported channel, follows up automatically, and reports an honest outcome.

- **Live:** <https://company-service.agentmasterkey.com>
- **Status:** V1 — vertical slice VERIFIED end-to-end (see
  [docs/TESTING.md](docs/TESTING.md) and [docs/V1_LIMITATIONS.md](docs/V1_LIMITATIONS.md))
- **Tracking:** [V1 epic](https://github.com/Antman316/company-service/issues/1)

## What it is not

Not a chatbot. The model is a swappable reasoning provider behind a policy
engine that independently decides what the agent may do. Merchant messages,
web pages, and tool output are untrusted input — they cannot expand the
customer's mandate, create approvals for themselves, or turn "promised" into
"received".

## Stack

| Layer | Choice |
|---|---|
| App/API | Cloudflare Workers (module worker, no framework) |
| Database | Cloudflare D1 (`company-service-db`) |
| Evidence files | Cloudflare R2 (`company-service-evidence`) |
| Durable follow-ups | Cron trigger every 5 min + `follow_ups` table |
| Frontend | React 19 + TypeScript + Vite, served from the Worker |
| Model layer | `ModelProvider` interface — `local_dev` (deterministic), `openai`, `anthropic`, `openai_compatible` |
| Tests | vitest + `@cloudflare/vitest-pool-workers` (19 tests) |

## Run locally

```bash
npm install
npm run migrate:local          # apply migrations to local D1
cp .dev.vars.example .dev.vars # SECRET_KEY + ENVIRONMENT=development
npm run dev                    # wrangler dev on :8787
npm run build && npm run dev   # web SPA on :5173 proxied to the worker
```

`npm test` runs the full suite. `npm run typecheck` is clean on both tsconfigs.

## Deploy

The canonical path is `npm run deploy` (`vite build` →
`scripts/gen-static.mjs` → `wrangler deploy`). This repo's V1 deploy was
performed through the Cloudflare API directly because the available credential
cannot drive `wrangler`/`assets-upload`/`workers.dev` enablement; the worker
therefore serves the SPA from an inlined build (see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#static-serving)).

## Docs

- [PRODUCT_SPEC](docs/PRODUCT_SPEC.md) — what the product promises
- [ARCHITECTURE](docs/ARCHITECTURE.md) — components and data flow
- [AUTHORITY_MODEL](docs/AUTHORITY_MODEL.md) — mandates, grants, revocation
- [CASE_STATE_MACHINE](docs/CASE_STATE_MACHINE.md) — states and transitions
- [DATA_MODEL](docs/DATA_MODEL.md) — all 20 tables
- [PROVIDER_ARCHITECTURE](docs/PROVIDER_ARCHITECTURE.md) — model providers + routing
- [COMPANY_ADAPTERS](docs/COMPANY_ADAPTERS.md) — adapters + coverage registry
- [EMAIL_ARCHITECTURE](docs/EMAIL_ARCHITECTURE.md) — threading, transports, inbound
- [BROWSER_ARCHITECTURE](docs/BROWSER_ARCHITECTURE.md) — browser execution plan (designed, not built)
- [SECURITY](docs/SECURITY.md) — controls, threat model, injection defense
- [TESTING](docs/TESTING.md) — scenarios A–F + suite
- [V1_LIMITATIONS](docs/V1_LIMITATIONS.md) — what is NOT done
- [ROADMAP](docs/ROADMAP.md) — V1.1 priorities
