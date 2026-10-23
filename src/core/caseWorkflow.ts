import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { q1 } from "./db";
import { markFired, claimForRecovery, recordEffect } from "./followups";
import { runFollowUpFire } from "./agent";
import { reportError } from "./ops";

// M9 — durable per-follow-up execution via Cloudflare Workflows. Each
// scheduleFollowUp arms one instance that sleeps until due_at then fires the
// step; the 5-minute cron sweep stays as the backstop (markFired's atomic
// pending→fired claim makes the two paths safe to run together — whoever
// claims first wins, the other sees the row already fired).

interface FollowUpParams {
  followUpId: string;
  caseId: string;
}

export class CaseWorkflow extends WorkflowEntrypoint<Env, FollowUpParams> {
  async run(event: WorkflowEvent<FollowUpParams>, step: WorkflowStep): Promise<void> {
    const { followUpId, caseId } = event.payload;
    const env = this.env;

    const fu = await step.do("load", async () =>
      q1<{ id: string; case_id: string; kind: string; due_at: string; status: string }>(
        env.DB,
        `SELECT id, case_id, kind, due_at, status FROM follow_ups WHERE id = ?`,
        followUpId,
      ),
    );
    if (!fu || fu.status !== "pending") return;

    await step.sleepUntil("until-due", new Date(fu.due_at));

    await step.do("fire", async () => {
      // Atomic claim — the cron sweep may have beaten the workflow to it.
      // WO-2: on a step retry markFired no-ops (status is already 'fired'),
      // which previously dropped the followUpId and orphaned the claim.
      // claimForRecovery re-acquires the lease instead: this step only retries
      // when its own prior attempt provably died, so a max cutoff is safe —
      // and terminal states (reconciled/dismissed) are never recoverable, so
      // an effect the sweep already completed cannot be replayed.
      const firstTry = await markFired(env.DB, followUpId);
      const claimed = firstTry || (await claimForRecovery(env.DB, followUpId, "9999-12-31T23:59:59.999Z"));
      if (!claimed) return;
      try {
        await runFollowUpFire(env, caseId, fu.kind, followUpId, { reattempt: !firstTry });
      } catch (e) {
        await recordEffect(env.DB, caseId, followUpId, "unknown", e instanceof Error ? e.message : String(e));
        await reportError(env, e, { route: "workflow/fire", kind: "case_workflow", caseId });
        throw e; // let the workflow's own retry policy handle it
      }
    });
  }
}

// Arm a workflow instance for a freshly-scheduled follow-up. Optional: when
// the binding isn't configured (local tests, older deploys) the cron sweep
// covers the same rows, so failure here is audit-only. Kept in ops.ts to
// avoid a module cycle (followups → caseWorkflow → agent → followups).
