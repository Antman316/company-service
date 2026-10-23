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
export async function markFired(db: D1Database, id: string, claimant?: string): Promise<boolean> {
  const ts = nowIso();
  const r = await run(
    db,
    `UPDATE follow_ups SET status = 'fired', fired_at = ?, attempt = attempt + 1,
       effect_state = 'claimed', effect_at = ?, claimed_by = ?
     WHERE id = ? AND status = 'pending'`,
    ts,
    ts,
    claimant ?? null,
    id,
  );
  return (r.meta?.changes ?? 0) > 0;
}

// Non-terminal effect states a recovery claim may pick up. 'accepted' is
// reclaimable because the effect is idempotent at the case_actions key — a
// retry re-attaches to the same action row instead of duplicating a send.
const RECOVERABLE_EFFECT_STATES = "('claimed','attempted','accepted','unknown')";

// Lease-exclusion floor: a lease younger than this is live by definition, so
// no caller-supplied cutoff may steal it. Matches the sweep's recovery grace
// window — an unrelated claimant only ever sees leases old enough to be
// genuinely stranded.
export const RECOVERY_LEASE_MS = 10 * 60 * 1000;

// Effective staleness cutoff: the caller's claimedBeforeIso clamped by the
// lease-exclusion floor, so even a max-timestamp caller cannot reach a fresh
// live lease.
function recoveryCutoff(claimedBeforeIso: string): string {
  const parsed = Date.parse(claimedBeforeIso);
  const floor = Date.now() - RECOVERY_LEASE_MS;
  return new Date(Math.min(Number.isNaN(parsed) ? floor : parsed, floor)).toISOString();
}

// Lease re-acquire on an already-'fired' row whose effect never reached a
// terminal state (crash/throw/unknown between claim and completion). Two ways
// in, either is sufficient:
//  - provable retry ownership: `claimant` equals the row's claimed_by stamp,
//    i.e. the same lease holder (e.g. a workflow instance retrying its own
//    dead attempt — a step only re-runs after its prior invocation ended).
//  - lease exclusion: the lease is older than RECOVERY_LEASE_MS, so the prior
//    attempt is provably stale regardless of what claimedBeforeIso says.
// A caller with no proof of ownership and only a far-future cutoff gets
// neither — it cannot steal a fresh live lease. Terminal states
// (reconciled/dismissed) are never recoverable.
export async function claimForRecovery(
  db: D1Database,
  id: string,
  claimedBeforeIso: string,
  claimant?: string,
): Promise<boolean> {
  const r = await run(
    db,
    `UPDATE follow_ups SET effect_state = 'claimed', effect_at = ?, attempt = attempt + 1,
       claimed_by = ?
     WHERE id = ? AND status = 'fired'
       AND effect_state IN ${RECOVERABLE_EFFECT_STATES}
       AND ((claimed_by IS NOT NULL AND claimed_by = ?) OR effect_at < ?)`,
    nowIso(),
    claimant ?? null,
    id,
    claimant ?? null,
    recoveryCutoff(claimedBeforeIso),
  );
  return (r.meta?.changes ?? 0) > 0;
}

// Rows claimed whose effect never reconciled — the sweep's recovery backstop.
// The scan uses the same clamped cutoff as claimForRecovery so a fresh live
// lease is never enumerated as stranded.
export async function strandedEffects(db: D1Database, claimedBeforeIso: string, limit = 25) {
  return q<{ id: string; case_id: string; kind: string }>(
    db,
    `SELECT id, case_id, kind FROM follow_ups
     WHERE status = 'fired' AND effect_state IN ${RECOVERABLE_EFFECT_STATES}
       AND effect_at < ? ORDER BY effect_at ASC LIMIT ?`,
    recoveryCutoff(claimedBeforeIso),
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
