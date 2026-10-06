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
  env?: Env,
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
  // M9: when a CASE_WORKFLOW binding exists, arm a durable instance that
  // sleeps until due_at; the cron sweep remains the backstop either way.
  if (env) {
    const { armFollowUpWorkflow } = await import("./ops");
    await armFollowUpWorkflow(env, id, caseId);
  }
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

// Atomic claim: only transitions pending → fired, returns whether THIS
// caller won. Lets the cron sweep and the per-case workflow run the same
// schedule without double-firing (M9), and fixes the latent race where two
// overlapping sweeps could both fire one follow-up.
export async function markFired(db: D1Database, id: string): Promise<boolean> {
  const r = await run(
    db,
    `UPDATE follow_ups SET status = 'fired', fired_at = ?, attempt = attempt + 1 WHERE id = ? AND status = 'pending'`,
    nowIso(),
    id,
  );
  return (r.meta?.changes ?? 0) > 0;
}

export async function cancelFollowUps(db: D1Database, caseId: string): Promise<void> {
  await run(db, `UPDATE follow_ups SET status = 'cancelled' WHERE case_id = ? AND status = 'pending'`, caseId);
}
