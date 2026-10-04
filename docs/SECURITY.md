# Security

## Threat model

Company Service holds: customer identity, order metadata, receipts/evidence,
merchant conversations, connection secrets (provider API keys, email tokens).
The adversaries are (a) merchants' untrusted content attempting instruction
injection, (b) a compromised model provider producing out-of-policy actions,
(c) ordinary web threats, (d) cross-tenant access.

## Controls — IMPLEMENTED

- **Auth:** email+password signup/signin; PBKDF2-SHA256 (100k iterations —
  Workers WebCrypto cap), per-user salt; HttpOnly `Secure` `SameSite=Strict`
  session cookie, 30-day expiry; session row stores only `sha256(token)`.
- **CSRF:** every mutation requires `x-csrf` matching the per-session token
  issued at auth (Strict cookies alone aren't relied on).
- **Tenant isolation:** every query scoped by session `user_id`; isolation
  test covers read+mutate from a second user.
- **Policy engine:** deterministic classification before every action — the
  model cannot self-authorize (see AUTHORITY_MODEL).
- **Secrets at rest:** `encryptJson` AES-256-GCM (random IV) over connection
  configs; key = `SECRET_KEY` env/secret binding; secrets are never written to
  model context, events, or messages.
- **Prompt-injection defense:** `security/injection.ts` — strict separation of
  system policy / user authority / case objective / `untrusted` external
  content in every `ModelRequest`; `detectInjection` screens inbound email,
  merchant replies, and tool output before interpretation; hits write
  `prompt_injection` audit events (Scenario C test).
- **Evidence integrity:** sha256 on every stored evidence row; R2 objects are
  immutable per-id keys.
- **Honest outcomes:** outcome trail is append-only — no path mutates a
  PROMISED into RESOLVED without a matching evidence event.
- **Audit trail:** `audit_events` for auth, injection, revocation, csrf,
  coverage denials; `case_events` for every action/result/retry.
- **Rate limiting:** login attempts + per-user request counters in D1 (basic;
  see gaps).
- **Minimal secrets footprint:** only `SECRET_KEY` is a deploy secret; no
  provider keys ship with the app.

## Known gaps (honest)

- No 2FA on customer accounts (V1.1).
- Rate limiting is counter-based in D1, not Cloudflare-native throttling.
- `SECRET_KEY` rotation requires re-encrypting `config_enc` rows (script
  planned).
- Email inbound shared-secret auth until real routing lands.
- Data export/deletion endpoints designed but not shipped (schema supports
  cascade deletes; `/api/account/export|delete` V1.1).
- RLS equivalent doesn't exist in D1 — isolation depends on app-layer
  filtering (mitigated by tests).
