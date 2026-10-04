# Company Adapters & Coverage Registry

## Adapter interface (`core/types.ts`)

```ts
interface CompanyAdapter {
  companyId: string;
  checkCoverage(request: CoverageRequest): Promise<CoverageResult>;
  execute(action: CompanyAction, context: ExecutionContext): Promise<ActionResult>;
  getStatus?(reference: ExternalCaseReference): Promise<ExternalStatus>;
}
```

Route priority (registry `ROUTE_PRIORITY`): `api > mcp > protocol > email >
chat > computer > manual`. The best usable coverage row wins; nothing pretends
a weaker channel is stronger.

## Coverage registry (`company_coverage`)

Coverage is per **company × issue type × channel** — never "Amazon is
supported". Columns: `country`, `issue_type`, `channel`, `auth_requirements`,
`automation_level` (`AUTOMATED | ASSISTED | MANUAL_HANDOFF |
TEMPORARILY_UNAVAILABLE | UNSUPPORTED`), `verification_status` (`VERIFIED |
SIMULATED | UNVERIFIED`), `limitations`, `adapter_version`, `health`,
`last_verified_at`.

The Connections page renders the honest chip: `SIMULATED`/`UNVERIFIED` rows
show their verification status, not a rosy automation level.

### Registry today

| Company | Channel | Issue | Level | Verification |
|---|---|---|---|---|
| Test Merchant | email | any | AUTOMATED | **SIMULATED** |
| Test Merchant | chat | any | ASSISTED | UNVERIFIED |
| Amazon | email | return_refund_pending | MANUAL_HANDOFF | UNVERIFIED |
| (everything else) | — | — | — | UNSUPPORTED by default |

Unknown company → `coverage: uncovered` → case `UNSUPPORTED` +
`manual_handoff` event. Scenario E verifies no fabricated support.

## Test Merchant (`adapters/testMerchant.ts`) — SIMULATED

Deterministic simulated retailer for end-to-end verification:

- `execute(send_message)` writes the outbound email, then generates a scripted
  reply from `merchant_sim_state` + scenario hint (promise / partial_offer /
  evidence_request / denial / delayed / escalation) and stores it as an
  inbound message — the whole merchant turn is recorded as evidence.
- Behaviors: refund promise with day-window, $60-store-credit partial offer
  (drives approval gating), evidence request, decline, delayed response,
  escalation ack, successful resolution.
- Enabled when `SIM_MERCHANT_ENABLED` or non-production env.

**Why a simulation:** the mandate requires proving the engine without claiming
real retailer coverage that hasn't been established. Everything the sim does
is labeled SIMULATED in the coverage UI and `verification_status` columns.

## Real adapters

None are VERIFIED yet. `checkCoverage` returns `uncovered` for real retailers
not registered, so the product honestly shows manual handoff rather than
fabricating automation — the correct V1.1 integration target is a single real
email support flow (see ROADMAP).
