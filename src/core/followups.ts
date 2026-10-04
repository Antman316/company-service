import { newId, nowIso, q, run } from "./db";
import { caseEvent } from "./events";

// Durable follow-ups: scheduled work survives restarts because it lives in D1.
// A cron sweep fires due items; each fire is one bounded agent cycle, never a
// continuously-running loop.

export async function scheduleFollowUp(
  db: D1Database,
  caseId: string,
  kind: string,
  dueAt: string,
  payload: Record<string, unknown> = {},
): Promise<string> {
  const id = newId("fup");
  await run(
    db,
    `INSERT INTO follow_ups (id, case_id, kind, due_at, payload_json) VALUES (?,?,?,?,?)`,
    id,
    caseId,
    kind,
    dueAt,
    JSON.stringify(payload),
  );
  await caseEvent(db, caseId, "followup_scheduled", "system", { followUpId: id, kind, dueAt });
  return id;
}

export async function dueFollowUps(db: D1Database, limit = 50) {
  return q<{ id: string; case_id: string; kind: string; due_at: string; payload_json: string | null; attempt: number }>(
    db,
    `SELECT id, case_id, kind, due_at, payload_json, attempt FROM follow_ups
     WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?`,
    nowIso(),
    limit,
  );
}

export async function markFired(db: D1Database, id: string): Promise<void> {
  await run(
    db,
    `UPDATE follow_ups SET status = 'fired', fired_at = ?, attempt = attempt + 1 WHERE id = ?`,
    nowIso(),
    id,
  );
}

export async function cancelFollowUps(db: D1Database, caseId: string): Promise<void> {
  await run(db, `UPDATE follow_ups SET status = 'cancelled' WHERE case_id = ? AND status = 'pending'`, caseId);
}
