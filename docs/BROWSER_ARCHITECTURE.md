# Browser Architecture

**Status: DESIGNED — NOT IMPLEMENTED in V1.**

## Decision (recorded for V1.1)

Option B — **customer-controlled browser companion** (Chrome extension or
dedicated profile) — is the preferred V1 direction over cloud-hosted browsers
(Option A), per the mandate's own preference, and here's the evidence:

| Criterion | A: cloud browser | B: customer-controlled |
|---|---|---|
| Credential exposure | merchant session cookies live on our infra | never leaves the user's browser |
| CAPTCHA/2FA | hostile by design | user solves in place, agent waits |
| Anti-bot/ToS risk | higher (datacenter fingerprints) | indistinguishable from the user's own use |
| Session security | we hold live merchant sessions | holds only a capability to post actions in one tab |
| User takeover | awkward | native — it's their tab |
| Cost | per-minute browser billing | ~zero |
| Reliability/audit | easier fleet-wide | per-user variance; extension can screenshot + log to the case |

Rule set that applies to either: **never** bypass CAPTCHA, bot checks, or rate
limits; never disguise automation; never store raw passwords; unsupported or
blocked flows degrade to `ASSISTED` + user handoff with the drafted content.

## V1 seam

- `channel: "chat"` exists in `company_coverage` (Test Merchant chat is
  ASSISTED/UNVERIFIED).
- `CompanyAdapter` has a `computer` channel slot in `ROUTE_PRIORITY`.
- `case_actions` records `browser_minutes` cost kind for future billing.
- ASSISTED flows already render as manual-handoff with drafted text.

## V1.1 sketch

1. Companion extension connects via pairing code, scoped to a single
   allowlisted support URL per case.
2. Commands arrive as case actions (open chat, paste drafted message, scrape
   reply) — DOM snapshots become evidence with screenshots.
3. Every step lands in `case_events`/`cost_events` like any other channel.

Until that exists, browser-based merchant flows report `ASSISTED` and hand the
draft to the customer — honestly, not pretending the automation works.
