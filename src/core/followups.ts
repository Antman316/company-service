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
// overlapping sweeps could both fire one follow-up. WO-2: the same UPDATE
// stamps the effect ledger at 'claimed' so a post-claim crash is a distinct
// persisted state, not silently indistinguishable from a completed send.
export async function markFired(db: D1Database, id: string): Promise<boolean> {
  const ts = nowIso();
  const r = await run(
    db,
    `UPDATE follow_ups SET status = 'fired', fired_at = ?, attempt = attempt + 1,
       effect_state = 'claimed', effect_at = ?
     WHERE id = ? AND status = 'pending'`,
    ts,
    ts,
    id,
  );
  return (r.meta?.changes ?? 0) > 0;
}

// Non-terminal effect states a recovery claim may pick up. 'accepted' is
// reclaimable because the effect is idempotent at the case_actions key — a
// retry re-attaches to the same action row instead of duplicating a send.
const RECOVERABLE_EFFECT_STATES = "('claimed','attempted','accepted','unknown')";

// Lease re-acquire on an already-'fired' row whose effect never reached a
// terminal state (crash/throw/unknown between claim and completion). Only rows
// stamped before claimedBeforeIso are eligible — the sweep passes a grace
// cutoff so it cannot steal a live in-flight attempt; a workflow step retry
// passes a zero/epoch cutoff because its own prior attempt provably died.
export async function claimForRecovery(
  db: D1Database,
  id: string,
  claimedBeforeIso: string,
): Promise<boolean> {
  const r = await run(
    db,
    `UPDATE follow_ups SET effect_state = 'claimed', effect_at = ?, attempt = attempt + 1
     WHERE id = ? AND status = 'fired'
       AND effect_state IN ${RECOVERABLE_EFFECT_STATES}
       AND effect_at < ?`,
    nowIso(),
    id,
    claimedBeforeIso,
  );
  return (r.meta?.changes ?? 0) > 0;
}

// Rows claimed whose effect never reconciled — the sweep's recovery backstop.
export async function strandedEffects(db: D1Database, claimedBeforeIso: string, limit = 25) {
  return q<{ id: string; case_id: string; kind: string }>(
    db,
    `SELECT id, case_id, kind FROM follow_ups
     WHERE status = 'fired' AND effect_state IN ${RECOVERABLE_EFFECT_STATES}
       AND effect_at < ? ORDER BY effect_at ASC LIMIT ?`,
    claimedBeforeIso,
    limit,
  );
}

// Persist one effect-ledger transition: the row's current state (drives
// recovery scans) plus an append-only case_events receipt (AC6 audit trail).
export async function recordEffect(
  db: D1Database,
  caseId: string,
  id: string,
  state: "claimed" | "attempted" | "accepted" | "unknown" | "reconciled" | "dismissed",
  note?: string,
): Promise<void> {
  await run(
    db,
    `UPDATE follow_ups SET effect_state = ?, effect_at = ?, effect_note = ? WHERE id = ?`,
    state,
    nowIso(),
    note ?? null,
    id,
  );
  await caseEvent(db, caseId, `followup_effect_${state}`, "system", { followUpId: id, note });
}

export async function cancelFollowUps(db: D1Database, caseId: string): Promise<void> {
  await run(db, `UPDATE follow_ups SET status = 'cancelled' WHERE case_id = ? AND status = 'pending'`, caseId);
}
