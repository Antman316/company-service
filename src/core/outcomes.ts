import { newId, nowIso, q1, run } from "./db";
import { caseEvent } from "./events";
import type { OutcomeStatus } from "./types";

// Outcome trail — the honest ledger. A refund being PROMISED is not RECEIVED;
// the UI and status read from this table and nothing else.

export async function recordOutcome(
  db: D1Database,
  caseId: string,
  status: OutcomeStatus,
  detail: string,
  opts: { actor?: string; evidenceNote?: string } = {},
): Promise<void> {
  await run(
    db,
    `INSERT INTO outcome_events (id, case_id, status, detail, evidence_note, actor, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    newId("out"),
    caseId,
    status,
    detail,
    opts.evidenceNote ?? null,
    opts.actor ?? "system",
    nowIso(),
  );
  await caseEvent(db, caseId, "outcome_update", opts.actor === "merchant" ? "merchant" : "system", {
    status,
    detail,
    evidenceNote: opts.evidenceNote ?? null,
  });
}

export async function latestOutcome(
  db: D1Database,
  caseId: string,
): Promise<{ status: OutcomeStatus; detail: string; created_at: string } | null> {
  return q1<{ status: OutcomeStatus; detail: string; created_at: string }>(
    db,
    `SELECT status, detail, created_at FROM outcome_events WHERE case_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    caseId,
  );
}
