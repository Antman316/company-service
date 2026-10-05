# Product Spec

## Thesis

Companies increasingly run sophisticated AI support stacks against consumers.
Company Service puts an agent on the consumer's side: *"You no longer have to
personally manage every frustrating interaction with a company."*

The customer describes the problem once. The product handles what it
legitimately can, asks when a real decision is needed, and reports exactly what
happened — nothing more.

## Scope — V1 (VERIFIED)

**Category:** online retail post-purchase problems only.

Supported issue types: `refund_not_received`, `return_refund_pending`,
`wrong_item`, `damaged_item`, `missing_item`, `incomplete_order`,
`order_status`, `other_post_purchase`.

**Channel:** email to the company's support address via `CompanyAdapter`. The
V1-verified adapter is the deterministic Test Merchant (SIMULATED).

**Explicitly out of V1:** airlines/telecom/utilities/subscriptions/travel/bill
negotiation/warranty, legal/insurance/financial/medical/government
representation, purchases, legal settlements.

## The customer experience

1. **Describe the problem** — one free-text box on the home page or `/new`.
   Example: *"Test Merchant owes me $84.17 for order TM-99 returned three
   weeks ago."*
2. **Review what was understood** — the objective draft shows company, issue
   type, order reference, amount, desired outcome, and the proposed mandate
   (what the agent may do / what always comes back).
3. **Grant a mandate** — the customer ticks capabilities. Nothing runs before
   this.
4. **Watch the timeline** — every action, message, evidence item, approval,
   state change is recorded on the case timeline.
5. **Decide when asked** — gated outcomes (partial refund, store credit,
   replacement, fees, new terms, closing satisfied) become Approval cards.
6. **Get the truth** — outcomes distinguish REQUESTED / ACKNOWLEDGED /
   PROMISED / APPROVED / ISSUED / RECEIVED / VERIFIED_RESOLVED. "Amazon stated
   the refund should arrive in 5–7 days" is never reported as received.
7. **Stay in control** — pause, resume, revoke the mandate, cancel the case.

## Screens (all IMPLEMENTED, visually verified)

| Route | Purpose |
|---|---|
| `/` | Landing: hero, 4-step how-it-works, honest capability note |
| `/signup`, `/signin` | Email+password auth |
| `/dashboard` | Active/waiting/resolved cases, pending approvals count |
| `/new` | Case intake: text → objective draft → evidence → mandate grant |
| `/cases/:id` | Company, status, outcome, mandate, claims, evidence, messages, follow-ups, approvals, timeline; pause/resume/revoke/cancel |
| `/approvals` | Approval inbox with accept/reject + context |
| `/connections` | Model providers (add/test/remove), email connections, coverage registry with honest verification chips |
| `/economics` | Per-case cost view, provider breakdown, follow-up stats |

## Trust model (product-level)

- Agent states it acts *on behalf of the customer* — no deceptive impersonation.
- The customer sees every sent and received message.
- Anything outside granted capabilities creates an Approval — the model cannot
  approve itself.
- Revocation stops all future actions and pending follow-ups immediately.

## Verification labels used across the product

- Case merchants: `VERIFIED` / `SIMULATED` / `REAL VERIFIED` / `ASSISTED` /
  `UNVERIFIED` / `UNSUPPORTED` (shown on `/connections` coverage list).
- Docs use `IMPLEMENTED`, `VERIFIED`, `PARTIAL`, `DESIGNED`, `UNVERIFIED`,
  `NOT IMPLEMENTED`, `BLOCKED`.
