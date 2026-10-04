# Case State Machine

States (`cases.status`):

```
DRAFT ──► NEEDS_INFORMATION ──► READY ──► AWAITING_AUTHORIZATION
                                          │ mandate activated
                                          ▼
                                      PLANNING ──► IN_PROGRESS ──┐
                                          ▲                      │
                                          │                      ▼
                        merchant reply ◄── WAITING_FOR_COMPANY ──┤
                                          │                      │
                          commitment made ├──► (follow_up_due) ──┘
                                          │
        ┌───────────────┬─────────────────┼───────────────┐
        ▼               ▼                 ▼               ▼
  WAITING_FOR_      RESOLUTION_       ESCALATION_      UNSUPPORTED
   CUSTOMER          PROPOSED          REQUIRED        (manual handoff)
        │               │
        ▼               ▼
   RESOLVED ──►  UNRESOLVED ──►  CANCELLED
```

Additional flag: `paused` (user pause/resume — sweep skips paused cases).

## Transition log

Every transition appends a `case_events` row of type `state_change` with
`from`, `to`, `reason`, `actor`. The timeline UI reads these verbatim — no
state is ever implied or reconstructed.

## Important transitions

- `createCaseFromText` → `DRAFT` if objective has everything, else
  `NEEDS_INFORMATION` (missing info listed as claims).
- Customer grants mandate while `NEEDS_INFORMATION` → `READY` (proceed
  anyway is an explicit customer choice).
- Coverage gate: `uncovered` → `UNSUPPORTED` + `manual_handoff` event.
- `PROMISED` outcome → `WAITING_FOR_COMPANY` + `check_commitment` follow-up.
- Approval created → `WAITING_FOR_CUSTOMER`; decision resumes the run.
- Promise fulfilled (VERIFIED_RESOLVED) → `RESOLVED`.
- Deadline passed + no fulfilment + `follow_up` grant → IN_PROGRESS follow-up;
  without the grant → `WAITING_FOR_CUSTOMER` with guidance.
- `cancel` → `CANCELLED` (terminal); mandate `revoked` halts all actions but
  keeps the case inspectable.

## Durability

No state lives in memory. Every transition is a D1 write; the cron sweep
re-drives `follow_ups` after restarts, deploys, or worker eviction — Scenario
D proves a "restart" mid-wait neither duplicates sends nor loses the
schedule.
