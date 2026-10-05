# Email Architecture

## Design goal

Minimum-permission email: send on the customer's behalf without reading their
whole inbox. Two real lanes ship in V1:

- **Inbound:** Cloudflare Email Routing → the worker's `email()` handler.
- **Outbound:** Resend API (send-only — no inbox access exists anywhere),
  or `gmail.send` on a customer-OAuth'd connection as an alternative.

## Implemented

| Piece | Status | Detail |
|---|---|---|
| `EmailTransport` interface | IMPLEMENTED | `send(msg)` → `{ok, messageId?}`; `pickTransport` chooses sim → gmail conn → resend conn → `env.RESEND_API_KEY` → dev_log |
| `sim` transport | VERIFIED | Test Merchant's inbound/outbound loop |
| `resend` transport | IMPLEMENTED — NOT LIVE-VERIFIED | `POST api.resend.com/emails`; stamps `Message-ID: <case-token@domain>` + `Reply-To: case+token@INBOUND_ADDRESS`; awaiting `RESEND_API_KEY` |
| `gmail.send` transport | IMPLEMENTED — NOT LIVE-VERIFIED | `POST gmail/v1/users/me/messages/send`, `gmail.send`-scoped token on an `email` connection |
| `dev_log` transport | IMPLEMENTED | audit-only fallback (writes the would-be send to events) |
| Email Routing inbound | IMPLEMENTED — ROUTE LIVE, RECEIPT PROOF PENDING | Literal rule `cases@agentmasterkey.com` → worker `email()`; PostalMime parses the real RFC822 stream |
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
