# Email Architecture

## Design goal

Minimum-permission email: send on the customer's behalf without reading their
whole inbox. Preferred route — `gmail.send` scope + a case-specific Reply-To —
so merchant replies land on our case addresses, not in the user's mailbox scan.

## Implemented

| Piece | Status | Detail |
|---|---|---|
| `EmailTransport` interface | IMPLEMENTED | `send(msg)`, `id`; selected per case by `pickTransport` |
| `sim` transport | VERIFIED | Test Merchant's inbound/outbound loop |
| `gmail.send` transport | IMPLEMENTED — NOT LIVE-VERIFIED | `POST gmail/v1/users/me/messages/send` with a `gmail.send`-scoped access token stored on an `email` connection; sets `Reply-To: <case-token>@EMAIL_DOMAIN` |
| `smtp-log` transport | IMPLEMENTED | audit-only fallback (writes the would-be send to events) |
| Threading | IMPLEMENTED | case token `[CS-<id-suffix>]` in subject + `external_conversations.external_ref`; `resolveInboundCase` maps replies by token/conversation/In-Reply-To heuristics |
| Inbound endpoint | IMPLEMENTED | `POST /api/email/inbound` (shared-secret auth) — parsed, deduped by `dedupe_key` UNIQUE, injection-screened, then `advanceCase` |
| Dedup | VERIFIED | `dedupe_key = sha256(from+subject+body[:200])`, UNIQUE constraint — same message never double-processes (idempotency test) |
| Sim inbound | dev-only | `POST /api/sim/inbound` exists only when `ENVIRONMENT != production` |

## Case addresses

Outbound messages set `From`/`Reply-To` to `case-<token>@<EMAIL_DOMAIN>` —
replies to that address belong to exactly one case. `EMAIL_DOMAIN` is a
worker env var (`case.company-service.example` in prod — placeholder domain;
real inbound needs a routed domain, see limitations).

## Inbound security

Every inbound body runs through `detectInjection` + the untrusted fence —
merchant text can influence interpretation, never authority. Headers/body are
stored raw for audit but rendered plain-text in the UI.

## Not built (V1.1)

- Real inbound routing (Cloudflare Email Routing worker → `/api/email/inbound`)
- Broad Gmail read access — intentionally avoided; only `gmail.send`
- Attachments on outbound email (evidence share via links is the interim)
- DKIM/SPF guidance docs for customer-facing sending
