import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { signup, createTestCase, grantMandate, dbOne, dbAll } from "./helpers";
import {
  scheduleFollowUp,
  markFired,
  claimForRecovery,
  strandedEffects,
  recordEffect,
} from "../src/core/followups";
import { runFollowUpSweep } from "../src/core/agent";

// WO-2 / effect-failure recovery (pm-delivery-activation-1-cafcs_pm, board
// t_bbdfeb4a controller comment 668): exercises the real effect ledger —
// markFired stamping 'claimed', a simulated post-claim failure journaled
// 'unknown', the sweep's stranded-effects backstop reconciling it through
// claimForRecovery + runFollowUpFire, competing recovery leases, fresh-lease
// protection, and terminal-state no-retry. All fixtures are local synthetic
// users/cases; the model resolves to the deterministic local_dev provider
// and the test env has no MAILOUT binding (dev-log transport).

const PAST = new Date(Date.now() - 1000).toISOString();
const OLD_STAMP = "2000-01-01T00:00:00Z";
const MAX_CUTOFF = "9999-12-31T23:59:59.999Z";

async function makeDueFollowUp(email: string) {
  const c = await signup(email);
  const caseId = await createTestCase(c, `wo2 effect recovery ${email}`);
  await grantMandate(c, caseId);
  const fupId = await scheduleFollowUp(env.DB, caseId, "first_contact", PAST, {
    via: "wo2-effect-recovery-test",
  });
  return { caseId, fupId };
}

describe("WO-2 effect ledger & recovery", () => {
  it("markFired stamps the claim lease: status fired + effect_state claimed", async () => {
    const { fupId } = await makeDueFollowUp("wo2a@test.local");
    expect(await markFired(env.DB, fupId)).toBe(true);
    const row = await dbOne<{
      status: string;
      attempt: number;
      effect_state: string;
      effect_at: string | null;
    }>(`SELECT status, attempt, effect_state, effect_at FROM follow_ups WHERE id = ?`, fupId);
    expect(row?.status).toBe("fired");
    expect(row?.attempt).toBe(1);
    expect(row?.effect_state).toBe("claimed");
    expect(row?.effect_at).toBeTruthy();
  });

  it("wired caller: sweep fires a due follow-up and reconciles the effect ledger", async () => {
    const { caseId, fupId } = await makeDueFollowUp("wo2b@test.local");
    const res = await runFollowUpSweep(env);
    expect(res.fired).toBeGreaterThanOrEqual(1);
    const row = await dbOne<{
      status: string;
      effect_state: string;
      effect_note: string | null;
      attempt: number;
    }>(`SELECT status, effect_state, effect_note, attempt FROM follow_ups WHERE id = ?`, fupId);
    expect(row?.status).toBe("fired");
    expect(row?.effect_state).toBe("reconciled");
    expect(row?.effect_note).toBe(`${caseId}:followup:${fupId}`);
    expect(row?.attempt).toBe(1);
    // The deterministic action key was used exactly once.
    const actions = await dbAll<{ id: string }>(
      `SELECT id FROM case_actions WHERE idempotency_key = ?`,
      `${caseId}:followup:${fupId}`,
    );
    expect(actions.length).toBe(1);
  });

  it("post-claim failure is journaled 'unknown' and the sweep backstop reconciles it bounded", async () => {
    const { caseId, fupId } = await makeDueFollowUp("wo2c@test.local");
    expect(await markFired(env.DB, fupId)).toBe(true);
    // Simulate the throw path the sweep/workflow catch blocks journal.
    await recordEffect(env.DB, caseId, fupId, "unknown", "simulated post-claim crash");
    // Age the lease past the sweep's grace window so it is stranded-eligible.
    await env.DB.prepare(`UPDATE follow_ups SET effect_at = ? WHERE id = ?`)
      .bind(OLD_STAMP, fupId)
      .run();
    const stranded = await strandedEffects(env.DB, new Date().toISOString());
    expect(stranded.map((s) => s.id)).toContain(fupId);

    await runFollowUpSweep(env);
    const row = await dbOne<{ effect_state: string; effect_note: string | null; attempt: number }>(
      `SELECT effect_state, effect_note, attempt FROM follow_ups WHERE id = ?`,
      fupId,
    );
    expect(row?.effect_state).toBe("reconciled");
    expect(row?.effect_note).toBe(`${caseId}:followup:${fupId}`);
    expect(row?.attempt).toBe(2); // initial markFired + one recovery re-lease
    // The re-run re-attached to the same deterministic action row — no duplicate.
    const actions = await dbAll<{ id: string }>(
      `SELECT id FROM case_actions WHERE idempotency_key = ?`,
      `${caseId}:followup:${fupId}`,
    );
    expect(actions.length).toBe(1);
  });

  it("competing recovery claims resolve to exactly one winner; fresh leases are not stolen", async () => {
    const { fupId } = await makeDueFollowUp("wo2d@test.local");
    expect(await markFired(env.DB, fupId)).toBe(true);
    await env.DB.prepare(`UPDATE follow_ups SET effect_at = ? WHERE id = ?`)
      .bind(OLD_STAMP, fupId)
      .run();
    // Peers sharing one grace cutoff (the sweep's usage) cannot double-claim:
    // the winner's re-stamp lands newer than the cutoff, so every overlap
    // that resolves after it observes 0 changed rows.
    const sharedCutoff = "2001-01-01T00:00:00Z";
    const winners = await Promise.all(
      Array.from({ length: 6 }, () => claimForRecovery(env.DB, fupId, sharedCutoff)),
    );
    expect(winners.filter(Boolean).length).toBe(1);
    // The winner's re-lease is fresh — a grace-bounded scanner must not touch it.
    const graceCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    expect((await strandedEffects(env.DB, graceCutoff)).map((s) => s.id)).not.toContain(fupId);
    expect(await claimForRecovery(env.DB, fupId, graceCutoff)).toBe(false);
  });

  it("terminal effects (reconciled/dismissed) never re-lease or replay", async () => {
    const { caseId, fupId } = await makeDueFollowUp("wo2e@test.local");
    expect(await markFired(env.DB, fupId)).toBe(true);
    await recordEffect(env.DB, caseId, fupId, "reconciled", `${caseId}:followup:${fupId}`);
    await env.DB.prepare(`UPDATE follow_ups SET effect_at = ? WHERE id = ?`)
      .bind(OLD_STAMP, fupId)
      .run();
    expect(await claimForRecovery(env.DB, fupId, MAX_CUTOFF)).toBe(false);
    expect(await markFired(env.DB, fupId)).toBe(false);
    const stranded = await strandedEffects(env.DB, MAX_CUTOFF);
    expect(stranded.map((s) => s.id)).not.toContain(fupId);
    const row = await dbOne<{ effect_state: string; attempt: number }>(
      `SELECT effect_state, attempt FROM follow_ups WHERE id = ?`,
      fupId,
    );
    expect(row?.effect_state).toBe("reconciled");
    expect(row?.attempt).toBe(1);
  });

  it("paused/terminal/missing-mandate guards dismiss instead of stranding", async () => {
    const c = await signup("wo2f@test.local");
    const caseId = await createTestCase(c, "wo2 guard dismissal");
    await grantMandate(c, caseId);
    const fupId = await scheduleFollowUp(env.DB, caseId, "first_contact", PAST, {});
    await env.DB.prepare(`UPDATE cases SET paused = 1 WHERE id = ?`).bind(caseId).run();
    await runFollowUpSweep(env);
    const row = await dbOne<{ status: string; effect_state: string }>(
      `SELECT status, effect_state FROM follow_ups WHERE id = ?`,
      fupId,
    );
    expect(row?.status).toBe("fired");
    expect(row?.effect_state).toBe("dismissed");
    expect((await strandedEffects(env.DB, MAX_CUTOFF)).map((s) => s.id)).not.toContain(fupId);
  });
});
