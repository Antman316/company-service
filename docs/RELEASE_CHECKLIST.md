# Release checklist & environments

Per R10: every prod change passes through staging first. Status of each row:
staging VERIFIED 2026-10-06 (signup + seed + sim inbound on the live route).

## Environments

| | Prod | Staging |
|---|---|---|
| URL | https://company-service.agentmasterkey.com | https://cs-staging.agentmasterkey.com |
| Worker | `company-service` | `company-service-staging` |
| D1 | `company-service-db` `e78401a5-765a-4db1-8cc9-b16d51d1d091` | `company-service-db-staging` `67461e33-8f67-4534-b849-5052aba4db98` |
| R2 | `company-service-evidence` | `company-service-evidence-staging` |
| `ENVIRONMENT` | `production` | `staging` (sim endpoints enabled) |
| Route | zone Workers route `company-service.agentmasterkey.com/*` + proxied AAAA `100::` | route `f80ee9504c2b47e5b6ad4493d872ac6d` + AAAA `ccc21d7b0018c5929c690c48291e94e0` |
| Secrets | `SECRET_KEY` etc. — preserve with `keep_bindings` | `SECRET_KEY` = org secret `CS_STAGING_SECRET_KEY` |

## Deploy recipe (d10a MCP — the only working credential)

Deploys go through the `cloudflare-d10a` MCP `execute` tool; direct REST with
`CLOUDFLARE_API_TOKEN` fails (expired, code 9109) and `wrangler deploy` has no
valid auth. Bundles over ~600 KB can't fit in a tool arg, so the base64 is
staged in D1 first.

1. `npm ci && npm run typecheck && npm test` (clean-checkout gates below).
2. `npm run build && node scripts/gen-static.mjs` — regenerates `src/static.ts`
   (revert it before committing: the repo keeps a committed stub).
3. `npx wrangler deploy --dry-run --outdir dist-worker` → `dist-worker/index.js`.
4. `CREATE TABLE IF NOT EXISTS deploy_stage (seq INTEGER PRIMARY KEY, chunk TEXT NOT NULL)`
   on a D1 you control (staging D1 used), `DELETE FROM deploy_stage`, then
   INSERT the bundle's base64 in ~45 KB chunks ordered by `seq`.
5. In one `execute`: `SELECT chunk … ORDER BY seq` → `atob` → build the
   multipart body as a string (`metadata` part with `main_module: "index.js"`,
   bindings, `compatibility_date`/`flags`, plus the `index.js` part) and
   `PUT /accounts/{acc}/workers/scripts/{worker}` with `rawBody: true`.
6. Prod metadata must include `keep_bindings: ["secret_text"]` (binding
   **types**, not names) so worker secrets survive; never pass a bare
   `secret_text` binding with no `text` (error 10021).

## Rollback

Keep the previous `dist-worker/index.js` bundle. Rollback = re-upload it
through the same staged-D1 path (no rebuild needed — immutable SPA assets
are content-hashed inside the bundle).

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
