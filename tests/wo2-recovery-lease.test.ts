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
import { runFollowUpFire } from "../src/core/agent";
import { CaseWorkflow } from "../src/core/caseWorkflow";
import type { WorkflowStep } from "cloudflare:workers";

// WO-2 correction (premium-correction-1): the recovery claim protocol is now
// provable-ownership-or-lease-exclusion. These tests pin the discrimination:
// a first CaseWorkflow callback that loses markFired to a live sweep holds no
// claimed_by proof, so its max-cutoff claimForRecovery cannot steal the fresh
// lease; a genuine step retry by the same instance can. All fixtures are
// local synthetic users/cases; model resolves to the deterministic local_dev
// provider and the test env has no MAILOUT binding.

const PAST = new Date(Date.now() - 1000).toISOString();
const OLD_STAMP = "2000-01-01T00:00:00Z";
const MAX_CUTOFF = "9999-12-31T23:59:59.999Z";

async function makeDueFollowUp(email: string) {
  const c = await signup(email);
  const caseId = await createTestCase(c, `wo2 recovery lease ${email}`);
  await grantMandate(c, caseId);
  const fupId = await scheduleFollowUp(env.DB, caseId, "first_contact", PAST, {
    via: "wo2-recovery-lease-test",
  });
  return { caseId, fupId };
}

// Runs the real CaseWorkflow.run with a step stub that executes each step
// callback in-line (like a WorkflowStep does) and captures the "fire"
// callback so a step retry — a re-invocation of the same callback — can be
// modelled without re-running the memoized load/sleep steps.
function workflowStep(beforeFire?: () => Promise<unknown>) {
  const firedCallbacks: Array<() => Promise<unknown>> = [];
  const step = {
    do: async (name: string, cb: () => Promise<unknown>) => {
      if (name === "fire") {
        firedCallbacks.push(cb);
        await beforeFire?.();
      }
      return cb();
    },
    sleepUntil: async () => {},
  };
  return { step, firedCallbacks };
}

async function runWorkflow(
  instanceId: string,
  followUpId: string,
  caseId: string,
  step: { do: (name: string, cb: () => Promise<unknown>) => Promise<unknown>; sleepUntil: () => Promise<void> },
) {
  await CaseWorkflow.prototype.run.call(
    { env } as unknown as CaseWorkflow,
    { payload: { followUpId, caseId }, instanceId, timestamp: new Date(), workflowName: "case-workflow" },
    step as unknown as WorkflowStep,
  );
}

describe("WO-2 recovery lease: provable ownership / lease exclusion", () => {
  it("real CaseWorkflow path: first callback losing to a live sweep cannot steal the fresh lease", async () => {
    const { caseId, fupId } = await makeDueFollowUp("wo2l-wf-first@test.local");
    const { step } = workflowStep(async () => {
      // The live sweep claims the row during the workflow's until-due sleep.
      await markFired(env.DB, fupId);
    });
    await runWorkflow("wf-inst-A", fupId, caseId, step);
    const row = await dbOne<{
      status: string; attempt: number; effect_state: string; claimed_by: string | null;
    }>(`SELECT status, attempt, effect_state, claimed_by FROM follow_ups WHERE id = ?`, fupId);
    // The sweep's claim is untouched — the workflow's max-cutoff recovery call
    // was denied because it held no ownership proof on a fresh lease.
    expect(row?.status).toBe("fired");
    expect(row?.attempt).toBe(1);
    expect(row?.effect_state).toBe("claimed");
    expect(row?.claimed_by).toBeNull();
    const actions = await dbAll<{ id: string }>(
      `SELECT id FROM case_actions WHERE idempotency_key = ?`,
      `${caseId}:followup:${fupId}`,
    );
    expect(actions.length).toBe(0); // no effect ran — nothing was stolen
  });

  it("owning instance retry re-acquires; foreign and anonymous claimants cannot steal a fresh lease", async () => {
    const { caseId, fupId } = await makeDueFollowUp("wo2l-owner@test.local");
    expect(await markFired(env.DB, fupId, "wf-inst-A")).toBe(true);
    let row = await dbOne<{ claimed_by: string | null; attempt?: number }>(
      `SELECT claimed_by FROM follow_ups WHERE id = ?`, fupId,
    );
    expect(row?.claimed_by).toBe("wf-inst-A");
    // Simulate the crash journal the fire callback's catch block writes.
    await recordEffect(env.DB, caseId, fupId, "unknown", "simulated post-claim crash");
    // Fresh lease: no cutoff rescues a claimant without ownership proof.
    expect(await claimForRecovery(env.DB, fupId, MAX_CUTOFF, "wf-inst-B")).toBe(false);
    expect(await claimForRecovery(env.DB, fupId, MAX_CUTOFF)).toBe(false);
    expect((await strandedEffects(env.DB, MAX_CUTOFF)).map((s) => s.id)).not.toContain(fupId);
    // Provable retry: the same instance re-acquires immediately.
    expect(await claimForRecovery(env.DB, fupId, MAX_CUTOFF, "wf-inst-A")).toBe(true);
    row = await dbOne<{ claimed_by: string | null; attempt: number }>(
      `SELECT claimed_by, attempt FROM follow_ups WHERE id = ?`, fupId,
    );
    expect(row?.claimed_by).toBe("wf-inst-A");
    expect(row?.attempt).toBe(2);
    // Re-attach is idempotent — no duplicate external effect.
    await runFollowUpFire(env, caseId, "first_contact", fupId, { reattempt: true });
    const actions = await dbAll<{ id: string }>(
      `SELECT id FROM case_actions WHERE idempotency_key = ?`,
      `${caseId}:followup:${fupId}`,
    );
    expect(actions.length).toBe(1);
    // Terminal state stays terminal — ownership cannot resurrect it.
    expect(await claimForRecovery(env.DB, fupId, MAX_CUTOFF, "wf-inst-A")).toBe(false);
  });

  it("a genuinely stale lease transfers to a new claimant and the superseded owner cannot take it back", async () => {
    const { caseId, fupId } = await makeDueFollowUp("wo2l-stale@test.local");
    expect(await markFired(env.DB, fupId, "wf-inst-A")).toBe(true);
    await recordEffect(env.DB, caseId, fupId, "unknown", "simulated post-claim crash");
    await env.DB.prepare(`UPDATE follow_ups SET effect_at = ? WHERE id = ?`)
      .bind(OLD_STAMP, fupId)
      .run();
    // Anonymous sweep-path recovery works once the lease is provably stale.
    expect(await claimForRecovery(env.DB, fupId, new Date().toISOString())).toBe(true);
    const row = await dbOne<{ claimed_by: string | null; attempt: number }>(
      `SELECT claimed_by, attempt FROM follow_ups WHERE id = ?`, fupId,
    );
    expect(row?.claimed_by).toBeNull();
    expect(row?.attempt).toBe(2);
    // The prior owner's stamp was superseded — its proof no longer matches,
    // and the re-lease is fresh, so it cannot reclaim.
    expect(await claimForRecovery(env.DB, fupId, MAX_CUTOFF, "wf-inst-A")).toBe(false);
  });
});
