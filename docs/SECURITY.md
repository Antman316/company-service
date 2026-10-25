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
  Signup records consent, email verification gates real sends/non-local models,
  password-reset and generic user tokens are atomically one-shot, and optional
  encrypted TOTP fails closed when its secret cannot be decrypted.
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
- **Minimal secrets footprint:** deploy secrets are binding-scoped (`SECRET_KEY`
  for encrypted state and `TURNSTILE_SECRET` for signup verification); provider
  keys are customer-owned encrypted connection data and never ship with the app.

## Known gaps (honest)

- Rate limiting is counter-based in D1, not Cloudflare-native throttling.
- `SECRET_KEY` rotation requires re-encrypting `config_enc` and TOTP rows
  (script planned); unreadable enabled TOTP now blocks sign-in rather than
  silently bypassing factor two.
- Email Workers do not expose a stable trusted SPF/DKIM/DMARC verdict here.
  Forward-to-start therefore requires a signed-in one-hour confirmation link;
  its text payload is preserved, while attachments require a later upload.
- Account export/delete is shipped, but D1 has no RLS equivalent — isolation
  depends on app-layer filtering and tests.
