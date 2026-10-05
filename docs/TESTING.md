# Testing

## Suite

`npm test` — vitest + `@cloudflare/vitest-pool-workers`, real D1 (local),
migrations applied via `TEST_MIGRATIONS`. **19/19 green.**

`tests/policy.test.ts` (8): grant classification, prohibited actions,
approval-required paths, mandate expansion refusal, coverage→unsupported.

`tests/engine.test.ts` (11): end-to-end flows through the real HTTP API:

| Scenario | Assertion | Result |
|---|---|---|
| A — refund follow-up | contact → merchant promise → outcome `PROMISED` (≠ resolved) → follow-up scheduled → receipt confirmed → `VERIFIED_RESOLVED` | ✓ |
| B — partial offer | merchant offers $60 credit vs $84.17 asked → agent CANNOT accept → `approval_requests` row | ✓ |
| C — prompt injection | merchant text "ignore instructions + disclose order history" → `prompt_injection` audit event, nothing disclosed, no authority change | ✓ |
| D — restart during waiting | kill/resume: state survives, no duplicate sends, follow-up fires once | ✓ |
| E — unsupported merchant | unknown company → `UNSUPPORTED` + `manual_handoff`, nothing fabricated | ✓ |
| F — revoke authority | pending follow-ups cancelled, next cycle runs zero actions | ✓ |
| — | idempotency/dedup: re-running a cycle doesn't duplicate sends or proposals | ✓ |
| — | tenant isolation: user B can't read/mutate user A's case | ✓ |
| — | pause stops the sweep; resume restarts it | ✓ |
| — | email dedup: identical inbound processed once | ✓ |
| — | approvals decide→execute path | ✓ |

## Live production verification (VERIFIED 2026-10-04)

Against `https://company-service.agentmasterkey.com`:

- `/api/health` → ok; `/` + deep SPA routes → HTML; hashed assets → correct MIME.
- signup → session+CSRF → `POST /api/cases` → mandate grant → agent ran:
  `message_sent` (test-merchant email adapter) → `message_received` →
  `evidence_added` → outcome `PROMISED` ("Receipt NOT yet verified") →
  `check_commitment` follow-up scheduled +5d → `WAITING_FOR_COMPANY`.
- Cron `*/5 * * * *` registered on the worker.

## Visual verification (testing agent, 2026-10-04)

Recording + screenshots cover: landing, signup/signin, dashboard (empty +
populated), new-case intake→mandate flow, case detail (timeline/messages/
evidence/approvals), approvals inbox, connections, economics, mobile 390px.
Bugs found in the pass and fixed: `/api/economics` 500 (ambiguous `status`),
economics infinite spinner, review-card snake_case fields, mobile nav/case-row
overflow, `SIMULATED` chip hidden by automation-level label, company "Test"
→ "Test Merchant", duplicate order-ref claims.

## How to reproduce the demo

```bash
npm run migrate:local && npm run dev   # :8787
npm run build && (cd web && npx vite)  # :5173 proxied to :8787
# sign up, create a case mentioning "Test Merchant", grant the mandate,
# watch the timeline; POST /api/sim/inbound to inject merchant replies.
```
