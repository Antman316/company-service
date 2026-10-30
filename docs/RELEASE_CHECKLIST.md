# Release checklist & environments

Per R10: every prod change passes through staging first. Status of each row:
staging VERIFIED 2026-10-06 (signup + seed + sim inbound on the live route).

## Environments

Hostnames, worker names, database identifiers, route identifiers, DNS record
identifiers, and deploy credential names are not listed here. They live in
the private release runbook. Do not copy them back into this file.

## Deploy recipe

A previous deploy credential was retired. Use the credential recorded in the
private release runbook. Prefer `wrangler deploy` when that credential can
drive it; otherwise follow the private runbook's upload steps. Do not record
account identifiers, database identifiers, route identifiers, DNS record
identifiers, or credential names in this file.

1. `npm ci && npm run typecheck && npm test` (clean-checkout gates below).
2. `npm run build && node scripts/gen-static.mjs` — regenerates `src/static.ts`
   (revert it before committing: the repo keeps a committed stub).
3. `npx wrangler deploy --dry-run --outdir dist-worker` → `dist-worker/index.js`.
4. If the private runbook requires a staged upload for a bundle that will not
   fit in a single tool argument, follow that runbook. Do not put bundle
   bytes or resource identifiers in this file.
5. Production metadata must include `keep_bindings: ["secret_text"]` (binding
   **types**, not names) so worker secrets survive; never pass a bare
   `secret_text` binding with no `text` (error 10021).
   `plain_text` bindings (vars) are rewritten by the upload — always carry
   the full set from `wrangler.jsonc` **plus** `APP_ORIGIN` and
   `TURNSTILE_SITE_KEY` (M7), or signup/email links lose their config.
   `TURNSTILE_SECRET` itself stays a `secret_text` binding (already set on
   both workers — provisioned 2026-10-06).
7. **The manual upload wipes the cron schedule.** The scripts PUT replaces
   the whole deployment spec, so after every manual deploy re-register:
   `PUT /accounts/{acc}/workers/scripts/{worker}/schedules` with body
   `[{"cron":"*/5 * * * *"}]` (bare array — `{"crons":[…]}` is rejected
   with 10026). Verify with `GET …/schedules`. Workers Observability is
   also off on manual deploys, so D1 state (follow_ups.status) is the
   ground truth for whether the sweep fired.

## Rollback

Keep the previous `dist-worker/index.js` bundle. Rollback = re-upload it
through the same path recorded in the private release runbook (no rebuild
needed — immutable SPA assets are content-hashed inside the bundle).

## Checklist per deploy

- [ ] clean-checkout proof on the exact SHA: `git worktree add --detach <sha>`
      → `npm ci` → `npm run typecheck` → `npm test` → `npm run build` →
      `node scripts/gen-static.mjs` → dry-run bundle
- [ ] staging deploy + smoke: `/api/health` 200, signup works, Test Merchant
      sim cycle works (`POST /api/sim/inbound` enabled only when
      `ENVIRONMENT != production`)
- [ ] prod deploy + smoke: `/api/health` 200, hard-refresh the SPA
      (Cmd+Shift+R — restored tabs run the previous immutable bundle),
      confirm `assets/index-*.js` hash changed in `/` HTML
- [ ] record deployed SHA + bundle hash in the PR
- [ ] `V1_LIMITATIONS.md` updated if the boundary moved
