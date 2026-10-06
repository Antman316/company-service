import { json, q, q1, run } from "./db";
import { recordOutcome } from "./outcomes";

// M4 — Results & verification of money.
//
// The honest ladder: PROMISED/ISSUED (merchant-stated) → RECEIVED (split by
// evidence source) → VERIFIED_RESOLVED (document-verified money + customer
// confirm of overall resolution). Customer self-report alone never reaches
// the top tier — under contingency billing the customer has a direct
// incentive to answer "no", so self-report is not verification.
//
// Receipt tiers are derived from outcome_events rows (append-only) — the
// evidence_note of the latest RECEIVED row carries the source:
//   customer_confirmed | document_verified[:<evidenceId>]
// A VERIFIED_RESOLVED row only ever gets written when the document-verified
// tier already stands AND the customer confirms the case is resolved.

export type ReceiptTier =
  | "none"
  | "customer_confirmed"
  | "document_verified"
  | "verified_resolved";

export const RECEIPT_TIER_LABELS: Record<ReceiptTier, string> = {
  none: "No receipt yet",
  customer_confirmed: "RECEIVED — customer confirmed (not document-verified)",
  document_verified: "RECEIVED — document verified",
  verified_resolved: "VERIFIED_RESOLVED",
};

export interface CaseResults {
  amount_claimed?: number | null;
  amount_recovered?: number;
  customer_minutes?: number;
  agent_messages_sent?: number;
  days_to_resolution?: number;
  escalation_max_rung?: number;
  // Starting state (R8) — all CUSTOMER_STATED at intake.
  days_overdue_at_start?: number;
  prior_customer_attempts?: number;
  refund_already_in_progress?: boolean;
  [k: string]: unknown;
}

export async function getResultsMeta(db: D1Database, caseId: string): Promise<CaseResults> {
  const row = await q1<{ meta: string | null }>(db, `SELECT meta FROM cases WHERE id = ?`, caseId);
  const meta = json<Record<string, unknown>>(row?.meta ?? "{}", {});
  return (meta.results ?? {}) as CaseResults;
}

export async function patchResults(db: D1Database, caseId: string, patch: CaseResults): Promise<void> {
  const current = await getResultsMeta(db, caseId);
  const merged = { ...current, ...patch };
  await run(
    db,
    `UPDATE cases SET meta = json_set(COALESCE(meta, '{}'), '$.results', json(?)) WHERE id = ?`,
    JSON.stringify(merged),
    caseId,
  );
}

/** Current receipt tier derived from the outcome trail — nothing is cached. */
export async function receiptState(
  db: D1Database,
  caseId: string,
): Promise<{ tier: ReceiptTier; amountRecoveredCents: number }> {
  const events = await q<{ status: string; evidence_note: string | null }>(
    db,
    `SELECT status, evidence_note FROM outcome_events WHERE case_id = ? ORDER BY rowid`,
    caseId,
  );
  let tier: ReceiptTier = "none";
  let amount = 0;
  for (const e of events) {
    if (e.status === "RECEIVED") {
      const src = e.evidence_note?.startsWith("document_verified") ? "document_verified" : "customer_confirmed";
      if (src === "document_verified" || tier !== "document_verified") tier = src as ReceiptTier;
    }
    if (e.status === "VERIFIED_RESOLVED") tier = "verified_resolved";
  }
  // amount_recovered lives in meta.results (maintained by recordReceipt).
  const r = await getResultsMeta(db, caseId);
  if (typeof r.amount_recovered === "number") amount = r.amount_recovered;
  return { tier, amountRecoveredCents: amount };
}

export async function recordReceipt(
  db: D1Database,
  caseId: string,
  input: {
    source: "customer_confirmed" | "document_verified";
    /** For customer_confirmed: money received in this event (additive).
     *  For document_verified: the TOTAL the document attests — the ledger adds
     *  only the increment over what's already recorded, so a document
     *  re-verifying already-confirmed money never double-counts. */
    amountCents: number;
    detail: string;
    evidenceId?: string;
  },
): Promise<void> {
  const note = `${input.source}${input.evidenceId ? `:${input.evidenceId}` : ""}`;
  await recordOutcome(db, caseId, "RECEIVED", input.detail, { actor: "customer", evidenceNote: note });
  const r = await getResultsMeta(db, caseId);
  const next = input.source === "document_verified"
    ? Math.max(r.amount_recovered ?? 0, input.amountCents)
    : (r.amount_recovered ?? 0) + input.amountCents;
  await patchResults(db, caseId, { amount_recovered: next });
}

/** Derived result fields, computed at close time (and on demand for detail). */
export async function derivedResults(db: D1Database, caseId: string) {
  const sent = await q1<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM external_messages m
     JOIN external_conversations c ON c.id = m.conversation_id
     WHERE c.case_id = ? AND m.direction = 'out' AND m.status = 'sent'`,
    caseId,
  );
  const rung = await q1<{ r: number | null }>(
    db,
    `SELECT MAX(rung) AS r FROM case_escalations WHERE case_id = ? AND status IN ('executed','awaiting_approval')`,
    caseId,
  );
  const created = await q1<{ created_at: string }>(db, `SELECT created_at FROM cases WHERE id = ?`, caseId);
  const closedAt = await q1<{ created_at: string }>(
    db,
    `SELECT created_at FROM outcome_events WHERE case_id = ? AND status IN ('VERIFIED_RESOLVED','UNRESOLVED') ORDER BY rowid DESC LIMIT 1`,
    caseId,
  );
  const days = closedAt && created
    ? Math.max(0, (Date.parse(closedAt.created_at) - Date.parse(created.created_at)) / 86_400_000)
    : null;
  return {
    agent_messages_sent: sent?.n ?? 0,
    escalation_max_rung: rung?.r ?? 0,
    days_to_resolution: days === null ? null : Math.round(days * 10) / 10,
  };
}

/** Stamp the derived fields into meta.results — call when a case reaches terminal. */
export async function finalizeResults(db: D1Database, caseId: string): Promise<void> {
  const d = await derivedResults(db, caseId);
  await patchResults(db, caseId, {
    agent_messages_sent: d.agent_messages_sent,
    escalation_max_rung: d.escalation_max_rung,
    ...(d.days_to_resolution !== null ? { days_to_resolution: d.days_to_resolution } : {}),
  });
}

// ---------------------------------------------------------------------------
// Public aggregate — /api/results. Counts and medians only; merchants with
// fewer than MIN_SAMPLE cases are grouped into "other" so no single case is
// inferable from the page.
// ---------------------------------------------------------------------------

const MIN_SAMPLE = 3;

export async function aggregateResults(db: D1Database) {
  const cases = await q<{
    id: string; company_name: string | null; status: string; meta: string | null;
  }>(db, `SELECT id, company_name, status, meta FROM cases`);

  type Agg = {
    cases: number; received: number; documentVerified: number; verifiedResolved: number;
    claimedCents: number; recoveredCents: number; days: number[]; escalated: number;
    recoveredAfterEscalation: number;
  };
  const blank = (): Agg => ({
    cases: 0, received: 0, documentVerified: 0, verifiedResolved: 0,
    claimedCents: 0, recoveredCents: 0, days: [], escalated: 0, recoveredAfterEscalation: 0,
  });

  const total = blank();
  const byMerchant = new Map<string, Agg>();
  const byChannel = new Map<string, Agg>();

  for (const c of cases) {
    const meta = json<Record<string, unknown>>(c.meta ?? "{}", {});
    const r = (meta.results ?? {}) as CaseResults;
    const claimed = typeof r.amount_claimed === "number" ? r.amount_claimed : 0;
    const recovered = typeof r.amount_recovered === "number" ? r.amount_recovered : 0;
    const rung = typeof r.escalation_max_rung === "number" ? r.escalation_max_rung : 0;
    const days = typeof r.days_to_resolution === "number" ? r.days_to_resolution : null;

    const outs = await q<{ status: string; evidence_note: string | null }>(
      db,
      `SELECT status, evidence_note FROM outcome_events WHERE case_id = ?`,
      c.id,
    );
    const received = outs.some((o) => o.status === "RECEIVED");
    const docV = outs.some((o) => o.status === "RECEIVED" && o.evidence_note?.startsWith("document_verified"));
    const verified = outs.some((o) => o.status === "VERIFIED_RESOLVED");

    const channel = await q1<{ channel: string }>(
      db,
      `SELECT channel FROM external_conversations WHERE case_id = ? ORDER BY created_at LIMIT 1`,
      c.id,
    );

    const buckets = [
      total,
      byMerchant.get(c.company_name ?? "unknown") ?? (() => { const a = blank(); byMerchant.set(c.company_name ?? "unknown", a); return a; })(),
      byChannel.get(channel?.channel ?? "none") ?? (() => { const a = blank(); byChannel.set(channel?.channel ?? "none", a); return a; })(),
    ];
    for (const b of buckets) {
      b.cases++;
      if (received) { b.received++; b.recoveredCents += recovered; }
      if (docV) b.documentVerified++;
      if (verified) b.verifiedResolved++;
      b.claimedCents += claimed;
      if (days !== null) b.days.push(days);
      if (rung >= 2) {
        b.escalated++;
        if (received) b.recoveredAfterEscalation++;
      }
    }
  }

  const med = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const shape = (a: Agg) => ({
    cases: a.cases,
    received: a.received,
    documentVerified: a.documentVerified,
    verifiedResolved: a.verifiedResolved,
    claimedCents: a.claimedCents,
    recoveredCents: a.recoveredCents,
    medianDaysToResolution: med(a.days),
    escalatedBeyondRung1: a.escalated,
    recoveredAfterEscalation: a.recoveredAfterEscalation,
  });

  // k-anonymity: merchants under the sample floor merge into "other".
  const merchants: Record<string, ReturnType<typeof shape>> = {};
  const other = blank();
  for (const [name, a] of byMerchant) {
    if (a.cases >= MIN_SAMPLE) merchants[name] = shape(a);
    else {
      for (const k of Object.keys(other) as (keyof Agg)[]) {
        if (k === "days") other.days.push(...a.days);
        else (other[k] as number) += a[k] as number;
      }
    }
  }
  if (other.cases > 0) merchants["other (fewer than 3 cases)"] = shape(other);

  return {
    generatedAt: new Date().toISOString(),
    caveat: "Counts include SIMULATED/test cases unless filtered per-environment; tiers are derived from the outcome trail.",
    total: shape(total),
    byMerchant: merchants,
    byChannel: Object.fromEntries([...byChannel].map(([k, v]) => [k, shape(v)])),
  };
}
