# Email Architecture

## Design goal

Minimum-permission email: send on the customer's behalf without reading their
whole inbox. Two real lanes ship in V1:

- **Inbound:** Cloudflare Email Routing → the worker's `email()` handler.
- **Outbound:** Cloudflare `send_email` binding (`MAILOUT`) — Email
  Routing's own managed SMTP path. No external credentials, no inbox
  access, managed DKIM/SPF on the same zone. `gmail.send` on a
  customer-OAuth'd connection takes precedence when connected; Resend
  remains an optional fallback transport.

## Implemented

| Piece | Status | Detail |
|---|---|---|
| `EmailTransport` interface | IMPLEMENTED | `send(msg)` → `{ok, messageId?}`; precedence: sim → gmail conn → `env.MAILOUT` (send_email) → resend conn → `env.RESEND_API_KEY` → dev_log |
| `cloudflare_send_email` transport | VERIFIED on prod | `EmailMessage` from `cloudflare:email` → `MAILOUT.send` — real mail through Cloudflare's managed SMTP. Prod proof: case outbound row `msg_muunvhw9zl8s2cc8re` → `service@chewy.com`, `external_id` = stamped `cs-<token>-<action>@agentmasterkey.com` |
| `sim` transport | VERIFIED | Test Merchant's inbound/outbound loop |
| `resend` transport | IMPLEMENTED — NOT LIVE-VERIFIED | `POST api.resend.com/emails`; optional fallback when `RESEND_API_KEY`/connection is configured |
| `gmail.send` transport | IMPLEMENTED — NOT LIVE-VERIFIED | `POST gmail/v1/users/me/messages/send`, `gmail.send`-scoped token on an `email` connection; wins over MAILOUT when connected (it's the customer's own mailbox) |
| `dev_log` transport | IMPLEMENTED | audit-only fallback (writes the would-be send to events) |
| Email Routing inbound | VERIFIED on prod | Literal rule `cases@agentmasterkey.com` → worker `email()`; real MX-transit message ingested 2026-10-05 (external msg `msg_muuniaf50l9j29c0p2`, CF-rewritten Message-ID, `receivedVia=cloudflare_email_routing`) |
| Case resolution | IMPLEMENTED | `resolveInboundCase`: `case+token@` to-address → `[CS-token]` subject tag → `In-Reply-To`/`References` `external_id` → conversation → case; unmatched → audit `inbound_rejected` + `setReject` |
| Dedup | VERIFIED | `external_messages.external_id` unique per `Message-ID` — same mail never processes twice (test + prod handler both covered) |
| Inbound domain guard | IMPLEMENTED | non-`INBOUND_ADDRESS` domains rejected before parsing (`inbound_wrong_domain` audit) |
| Attachments | IMPLEMENTED | MIME allowlist (`EVIDENCE_MIME_ALLOW` + `message/rfc822`), ≤5 MB each / ≤15 MB total → R2 evidence (provenance merchant); skips logged as `attachment_skipped` |
| Sim inbound | dev-only | `POST /api/sim/inbound` exists only when `ENVIRONMENT != production` |

## Case addresses

Outbound messages set `From`/`Reply-To` to `case+<token>@<INBOUND_ADDRESS>` —
replies to that address belong to exactly one case. `INBOUND_ADDRESS` is a
worker env var (`cases@agentmasterkey.com` in prod; the Email Routing rule is
the literal match, the apex catch-all is untouched).

## Inbound security

Every inbound body runs through `detectInjection` + the untrusted fence —
merchant text can influence interpretation, never authority. Sender/recipient
metadata is retained on the message row; headers/body stored for audit,
rendered plain-text in the UI. A merchant reply can wake a paused/waiting
case but can never widen the mandate.

## Not built (V1.1)

- Live public-route receipt proof (blocked on `RESEND_API_KEY` — dev VM has
  no outbound SMTP port 25)
- Broad Gmail read access — intentionally avoided
- Attachments on outbound email (evidence share via links is the interim)
- DKIM/SPF guidance docs for customer-facing sending
