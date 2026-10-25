# Company Service — Ops & Reliability (M9)

## Topology

```
Email Routing ──email()──> cheap preflight (domain, dedup, case resolve)
                          ├─ reject → setReject (real bounce)
                          ├─ INBOUND_Q bound → raw MIME → R2 inbound-raw/
                          │   → queue {r2Key, caseId}
                          │   → queue() consumer → full ingestInboundEmail
                          │     (idempotent re-preflight) → delete r2Key → ack
                          │   failure → msg.retry() (queue max_retries=3)
                          └─ no queue binding → synchronous ingest (same pipeline)
```

- Queue: `cs-inbound` (producer binding `INBOUND_Q`; consumer on the queue
  points at this worker, batch 10 / 5s / 3 retries). Raw MIME lives in R2
  because queue messages cap at 128KB and attachments exceed that.
- Workflows: `CASE_WORKFLOW` (class `CaseWorkflow`, one instance per
  follow-up id `wf_<fup_id>`). `scheduleFollowUp` arms it when the binding
  exists; `step.sleepUntil(due_at)` → atomic `markFired` claim →
  `runFollowUpFire`. The `*/5 * * * *` cron sweep is the backstop — the
  claim makes either-path-wins safe, and environments without the binding
  (local tests) work unchanged.
- Cron `*/5 * * * *`: follow-up sweep → monthly lane-health check (≤1/30d)
  → daily backup (≤1/23h).

## Error tracking + alerting

`reportError(env, err, {route, kind, userId, caseId})` is called from every
handler catch (`fetch`, `scheduled`, `email`, `queue` consumer) plus
workflow-arm failures. Each report writes `audit_events type=unhandled_error`
with a signature `sig = sha256(kind|route|message[:200])[:16]`. One alert
email per sig per hour goes to `OPS_ALERT_EMAIL` (default
`admin@agentmasterkey.com`) via `MAILOUT`; the send is recorded as
`audit_events type=error_alert`. Sentry remains NOT IMPLEMENTED — needs an
account + DSN secret from Anthony.

## Backup & restore

`runDailyBackup` (gated by `backupDue`, inside `scheduled()`) writes:

```
backups/YYYY-MM-DD/<table>.jsonl   — every table, one JSON row per line
backups/YYYY-MM-DD/manifest.json   — {generatedAt, environment, tables:{name:rows}}
```

to `env.EVIDENCE`. Days older than `BACKUP_RETENTION_DAYS` (default 30) are
pruned in the same run. Completion is audited (`backup_run`).

### Restore drill (performed from any machine with the CF API)

1. Download: `r2 object get` or console — fetch
   `backups/<date>/manifest.json` + the table files.
2. Target a scratch D1 (never prod directly): create one, apply
   `migrations/*.sql` in order.
3. Replay in FK-safe order — parent tables first (`users`, `cases`,
   `companies`, …) then children; JSONL→INSERT via a small script
   (one `INSERT OR IGNORE` per line; `d1 execute <db> --file=` accepts a
   generated .sql, or batch via the D1 `/query` API).
4. Verify: `SELECT COUNT(*)` per table vs the manifest.
5. For a production restore, pause deploys, restore, then re-run the
   latest migration files (they're `IF NOT EXISTS` / `OR IGNORE` — safe).

A drill was performed on staging 2026-10-06 — see PR notes.

## Zone rate limiting

Applied via the Cloudflare API (ruleset `66eb6bb8d05146c3999d530cd67d1256`,
`http_ratelimit` phase). The Free zone plan caps this phase hard — exactly
1 rule, period=10s, wildcard-only expressions, mitigation_timeout=10s — so
the single live rule covers the most abuse-sensitive surface:

- rule `571b1ce34e01453e959863048616499c` (`cs_auth_ratelimit`): block
  `(http.host in {"company-service.agentmasterkey.com" "cs-staging.agentmasterkey.com"}
   and http.request.uri.path wildcard "/api/auth/*")` at 4 req/10s per
  ip.src+colo — ~24/min effective, still far below brute-force pace and
  above real signup/signin/verify bursts. Host-scoped so nothing else on
  the zone can trip it.

`/api/companion/*` relies on the in-worker D1 counters (120/min +
4000/day per case) alone. If the zone upgrades to a paid plan, add the
companion rule (60 req/60s/IP) — the recipe is in the M9 PR notes.

## Status

Mission Control status row exists; unchanged by this milestone.
