# Red Team — V1 Ship Spec

Adversarial review of [V1_SHIP_SPEC.md](V1_SHIP_SPEC.md). Severity:
**S1** = would sink launch or create legal/abuse exposure, **S2** = would
miss a ship gate or blow the estimate, **S3** = worth fixing.
"Verify" marks claims I inferred but did not observe.

## S1 — must fix before building

### R1. Merchant replies won't come back to the case (M2.1)
The Gmail plan sends `From: customer@gmail.com` with
`Reply-To`/`CC: case+token@`. Ticketing systems (Zendesk, Salesforce,
Gladly, Sprinklr) usually answer the **requester address** (From) and
drop CCs and Reply-To. Merchant replies then land in the customer's
Gmail, which we can't read with `gmail.send` only, and the case stalls
silently. Reading the inbox needs `gmail.readonly`, a **restricted**
scope that requires a paid annual third-party security assessment
(CASA). That cost isn't in the spec.
**Fix:** at Gmail connect, walk the customer through setting up a
**Gmail forwarding filter** (from the merchant domains in the registry →
`cases@`). Gmail sends a confirmation code to `cases@`, which we ingest
and show the customer. Count the lane as working only after a merchant
reply is observed in the case. Add a "no reply in N days → check your
inbox / re-forward" prompt.

### R2. Refund-fraud amplifier (missing section)
A product that pushes merchants to refund "item not received" claims,
escalates automatically, and drafts chargebacks is also a tool for
**friendly fraud** at scale. Merchants will notice the
`agentmasterkey.com` pattern and blocklist the domain. That kills every
honest customer's lane, and card networks may tie it to chargeback
abuse.
**Fix (new milestone or part of M7):**
- the customer attests to the facts before the first send and before any chargeback/complaint draft
- one case per order
- pattern limits per user (claims per month, $ per month, repeat merchants)
- evidence required for `missing_item`/`damaged_item` (photo or carrier status)
- a fraud-signal review queue
- Terms that ban false claims, and account termination for them

### R3. Wrong legal framing in the escalation ladder (M3)
- "Reg E for debit" is **wrong for merchant disputes**. Reg E covers
  electronic fund transfer errors, not "the merchant didn't refund me."
  Debit purchase disputes usually run on card-network rules and bank
  policy. Fix: debit → "card issuer dispute (network rules)", no Reg E
  citation.
- FCBA billing-error rights carry a **60-day clock from the statement
  that first showed the charge**, and cover goods not delivered or not
  accepted. "Not as described" usually goes through network chargeback
  rules instead. The draft must say which applies, or say neither and
  let the bank decide.
- CFPB only fits financial products, so it's wrong for most retail cases.
  Keep it, but gate it on the payment-method issue type.
- Letters that cite statutes, and an AI drafting complaints to state
  attorneys general, edge toward legal advice / unauthorized practice of
  law. That's exactly the DoNotPay/FTC failure mode. Fix: drafts state
  facts and the customer's request, link out to official guidance pages,
  never predict outcomes, and carry a reviewed disclaimer. Get a
  one-time **lawyer review of the template set** (add to the ship gates).
- A prompt-injected merchant reply could steer a **regulator complaint**
  into false statements made in the customer's name. Fix: rungs 5–6 are
  rebuilt from structured case facts (claims with provenance) by a
  template, never free-form model text. Merchant text is not an input.

### R4. Customer-confirmed ≠ VERIFIED (M4)
"`VERIFIED_RESOLVED` after `RECEIVED` + customer confirm" makes customer
self-report the top tier. That breaks the honest-label discipline that is
the product's core. Under contingency billing (M8), customers also have a
direct incentive to answer "no."
**Fix:** `RECEIVED (customer-confirmed)` vs `RECEIVED (document-verified)`
from a forwarded refund email or bank-statement screenshot.
`VERIFIED_RESOLVED` requires document-verified. Billing keys on
document-verified or customer-confirmed with a card on file and terms.

### R5. Shared sending domain = single point of failure (M2.1 fallback)
Every non-Gmail customer sends as `case+…@agentmasterkey.com`. One
merchant's spam complaint or a blocklist hit takes out the whole fleet,
and many merchants refuse third parties ("we can only discuss with the
account holder").
**Fix:**
- move sending to a dedicated subdomain (e.g. `cases.agentmasterkey.com`)
  so the main domain's reputation is isolated
- attach a signed **authorization letter** (customer name, account email,
  order, scope) to the first message
- monitor bounces and complaints per merchant
- treat Gmail as the default lane, with MAILOUT as fallback, not the other
  way round

Also **verify** Cloudflare `send_email` limits and terms for third-party
recipients at volume. Prod sent to `service@chewy.com` successfully, but
daily caps and acceptable use for "on behalf of" mail aren't documented
in this repo.

## S2 — will miss a gate or the estimate

### R6. The merchant list doesn't fit the email-first plan (M6)
Many launch merchants **don't publish a support email** (Amazon, Walmart,
Apple, Temu, Shein, Costco, Target route to chat/phone/forms). The ≥15
VERIFIED gate will be met mostly by chat, so **M5 is the critical path,
not M2**. Web contact forms aren't a lane in the spec at all.
**Fix:**
- add a `form` channel (ASSISTED: draft → customer pastes into the form;
  the extension can prefill it)
- before committing to the list, audit the 25 merchants' real contact
  channels (one research pass)
- reorder so M5 starts right after M3

### R7. "Verify each lane with a real contact" conflicts with the no-false-statements rule
Verifying 25 lanes without real cases means sending fake inquiries. That's
`submit_false_statement` territory and it looks like spam.
**Fix:** lanes become VERIFIED only from real dogfood/beta cases. Use
"contact address confirmed on the official site" as a separate,
lower label (`CONTACT_CONFIRMED`). Then gate 3 is realistic only with a
beta of roughly 20–50 users, not one dogfooder.

### R8. The dogfood go/no-go is statistically weak
Ten cases from one user, with no baseline. Many merchants refund on their
own, so "60% RECEIVED" may just measure what would have happened anyway.
**Fix:**
- record each case's **starting state** (days overdue, prior attempts by
  the customer)
- count **outcomes after an escalation rung**, not raw RECEIVED
- report minutes saved against the customer's estimate
- extend to a 20–50 user beta before public launch
- make the threshold per lane (email vs chat)

### R9. Chat companion is underestimated and fragile (M5, 1.5 sessions)
- Merchant chat widgets usually run in **cross-origin iframes** from
  vendor domains (LivePerson, Salesforce, Sprinklr, Zendesk…). The
  extension needs `all_frames` + host permissions for those vendors,
  which widens Chrome Web Store review and the user-trust prompt.
- Per-merchant DOM selectors break often. That's ongoing maintenance with
  no owner in the spec.
- Transcripts rendered in the side panel are **untrusted HTML**, so there's
  an XSS risk inside a privileged extension. Text-only rendering is
  required.
- Store review takes days to weeks, and "reads pages + AI" listings get
  extra scrutiny.

**Fix:**
- ship the **generic mode first** (the user highlights the chat region
  once; read text only)
- add per-merchant selectors as an optimization
- add a selector-health check to the M6 cron
- re-estimate at 2.5–3 sessions plus store-review calendar time

### R10. No staging environment and no release process
Deploys are a manual multipart upload through the d10a MCP straight to
prod. The Cloudflare token is expired for REST. There's no CI by design.
Shipping to strangers with no staging and nothing between a local pass
and prod is risky, especially for the Workflows migration (M9) on live
cases.
**Fix:**
- add a `company-service-staging` worker + D1 + R2 and a scripted deploy
  (refresh the API token so wrangler works)
- write a release checklist (clean-checkout gates, staging smoke, prod
  smoke, rollback = re-upload previous bundle)
- keep the Actions-minutes rule: local gates, no new workflows unless
  Anthony approves

### R11. Migration naming collision
A `0003` migration was previously added and deleted. **Verify** whether
prod's `d1_migrations` table recorded it. If it did, a new
`0003_v1_ship.sql` will be skipped or conflict. **Fix:** name it
`0004_v1_ship.sql`, or check `d1_migrations` first. Make each statement
idempotent (`CREATE TABLE IF NOT EXISTS`).

### R12. Cost and abuse exposure from the platform model key (M1/M7)
Free first case + platform key + signup without email verification means
unbounded model spend from scripted signups. The $0.50/case cap doesn't
cap cases. **Fix:**
- require email verification before **any** model call, not just before sends
- per-user and global daily spend caps with alerting
- Cloudflare Turnstile on signup

### R13. Billing model leaks (M8)
- Attribution: if the merchant had already started the refund, a 20% fee
  feels like extortion and drives disputes against *us*.
- Charging after resolution with no card on file means low collection
  rates.
- Charging a share of money recovered through a chargeback the customer
  filed themselves is contentious.

**Fix:**
- card on file at mandate grant, with a clear fee preview
- no fee if the refund was already in progress at case start (from R8's
  starting state)
- exclude customer-filed chargebacks from the fee, or flat-fee them
- alternative to evaluate: a small flat fee per case ($5–10) during beta
  to learn willingness to pay

## S3 — fix while building

- **R14 Forward-to-start spoofing (M2.2):** "from verified account email"
  must check the authentication results (SPF/DKIM/DMARC alignment)
  that Email Routing passes through. Otherwise anyone can create cases
  for another user. Unauthenticated → confirm-by-link.
- **R15 Throttle conflicts:** "1 outbound/case/24h" blocks escalation
  replies and chat. Scope it to *unsolicited* email follow-ups only.
- **R16 Privacy/retention:** order data, addresses, and transcripts with
  no retention policy. Add auto-purge of evidence N days after close
  (configurable), honor state privacy-law requests (export/delete exist),
  and a data map in Privacy.
- **R17 Agent identity:** the spec should say outright that messages
  never pretend to *be* the customer. Gmail-sent messages are in the
  customer's name, so the signature must disclose "sent with the help of
  Company Service" (existing trust model), or that rule is violated in
  the Gmail lane.
- **R18 Deadlines need source data:** the chargeback window depends on the
  statement date, which we don't have. Prompt the customer for it and
  label the deadline `CUSTOMER_STATED`.
- **R19 Notifications through MAILOUT to the customer** go through the same
  shared-domain reputation (R5). Use the transactional subdomain.
- **R20 Estimates:** 6–7 sessions excludes calendar blockers: Google
  OAuth verification (weeks), Chrome Web Store review (days–weeks), lawyer
  template review, beta recruitment. A realistic plan is ~9–11 sessions plus
  4–8 weeks of calendar time.
- **R21 No support/ops path:** when a case goes wrong, there's no human
  escalation or support inbox for *our* customers, and no internal admin
  view to inspect a case (with consent). Add `/admin` read-only with
  audit logging.

## Recommended spec changes (summary)

1. Gmail lane: add the forwarding-filter step; count only observed replies (R1).
2. New **Abuse & fraud** section and gate (R2).
3. Rewrite M3 rungs 5–6: template-only, corrected FCBA/debit framing,
   lawyer review gate (R3).
4. Split RECEIVED by evidence source; VERIFIED_RESOLVED needs a document (R4).
5. Dedicated sending subdomain + authorization letter (R5).
6. Add `form` channel; move M5 ahead of M2 polish; channel audit of the 25 merchants (R6).
7. `CONTACT_CONFIRMED` label; verification only from real cases; 20–50 user beta (R7, R8).
8. M5 generic-mode-first, text-only rendering, re-estimate (R9).
9. Staging env + release checklist (R10); migration `0004` (R11).
10. Email-verify before model calls, spend caps, Turnstile (R12).
11. Card-on-file + attribution rules or flat beta fee (R13).
12. Revised estimate: ~9–11 sessions + 4–8 weeks calendar (R20).
