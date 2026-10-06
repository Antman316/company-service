import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { q1 } from "./db";
import { markFired } from "./followups";
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
      if (!(await markFired(env.DB, followUpId))) return;
      try {
        await runFollowUpFire(env, caseId, fu.kind);
      } catch (e) {
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
