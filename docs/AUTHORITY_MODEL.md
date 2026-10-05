# Authority Model

## Mandates

A mandate (`case_mandates`) is the bounded authority the customer grants per
case: `authorized` grants, `approvalRequired` grants, `prohibited` (always
present, cannot be removed), `expires_at`, `status`
(draft → active → revoked/expired/superseded).

- Created via `POST /api/cases/:id/mandate` — activating it kicks the case.
- Re-granting creates a new version and marks the old `superseded`.
- `POST /mandate/revoke` → status `revoked` + all pending follow-ups
  cancelled. Verified in Scenario F: the next cycle performs zero actions.
- The agent never writes mandate rows; only the HTTP layer (authenticated
  customer action) does.

## Grant vocabulary

| Grant | Class | Meaning |
|---|---|---|
| `contact_company` | authorized | open a support conversation |
| `request_refund` | authorized | ask for the owed amount |
| `share_order_number` | authorized | disclose order ref |
| `share_tracking_number` | authorized | disclose tracking ref |
| `share_evidence` | authorized | send attached evidence |
| `follow_up` | authorized | send deadline follow-ups |
| `request_escalation` | authorized | ask for a supervisor |
| `accept_partial_refund` | approval-required | less than requested |
| `accept_store_credit` | approval-required | credit instead of cash |
| `accept_replacement` | approval-required | replacement instead of refund |
| `agree_to_fee` | approval-required | any fee |
| `change_delivery` | approval-required | new delivery terms |
| `accept_new_terms` | approval-required | new conditions |
| `close_case_satisfied` | approval-required | close as resolved |
| `make_purchase`, `share_full_profile`, `change_security_credentials`, `accept_legal_settlement`, `submit_false_statement` | prohibited | never |

## Policy engine (`policy.ts`)

Deterministic — no LLM in the loop. `classifyAction(action, mandate)` returns:

- `PROHIBITED` — action kind in the prohibited set (purchases, credentials,
  false statements…) → blocked, logged.
- `UNSUPPORTED` — kind has no router mapping.
- `USER_APPROVAL_REQUIRED` — kind maps to an approval-required grant, or
  touches data outside granted shares (e.g. compose mentions tracking number
  without `share_tracking_number`).
- `AUTO_ALLOWED` — kind's grant is in `authorized`.

Offers from merchants are classified the same way: `accept_offer` is never in
the authorized vocabulary — every accept goes through an ApprovalRequest.

## Approvals

`approval_requests` rows carry `kind`, `summary`, `detail`, `options`
(merchant-offered alternatives), `status` (pending/approved/rejected/expired).
`POST /api/approvals/:id/decide` applies the decision: approved accept →
adapter `execute` → outcome event; reject → outcome event + optional re-offer.

## Non-expansion guarantee

Sources of expansion attempts — model output, merchant text, tool results —
all flow through `classifyAction`, which consults only the mandate row. There
is no code path for a non-customer actor to write `authorized` grants. Tested
in Scenario C (injection text produces a security event, not authority).
