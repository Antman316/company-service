import { newId, nowIso, q1, run } from "./db";
import { caseEvent } from "./events";
import { CASE_TRANSITIONS, type CaseRow, type CaseState } from "./types";

export async function getCase(db: D1Database, caseId: string): Promise<CaseRow | null> {
  return q1<CaseRow>(db, `SELECT * FROM cases WHERE id = ?`, caseId);
}

export class TransitionError extends Error {
  constructor(from: CaseState, to: CaseState) {
    super(`illegal case transition ${from} -> ${to}`);
  }
}

// The only way a case changes state. Enforces the transition table and stamps
// the timeline — callers never UPDATE cases.status directly.
export async function transitionCase(
  db: D1Database,
  caseId: string,
  to: CaseState,
  opts: { reason?: string; actor?: string } = {},
): Promise<CaseRow> {
  const c = await getCase(db, caseId);
  if (!c) throw new Error(`case ${caseId} not found`);
  if (c.status === to) return c;
  const allowed = CASE_TRANSITIONS[c.status] ?? [];
  if (!allowed.includes(to)) throw new TransitionError(c.status, to);
  const res = await run(
    db,
    `UPDATE cases SET status = ?, status_reason = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND status = ?`,
    to,
    opts.reason ?? null,
    nowIso(),
    caseId,
    c.status,
  );
  if (res.meta.changes === 0) {
    // Concurrent transition — re-read and re-validate instead of clobbering.
    const fresh = await getCase(db, caseId);
    if (!fresh || fresh.status === to) return fresh!;
    if (!(CASE_TRANSITIONS[fresh.status] ?? []).includes(to)) {
      throw new TransitionError(fresh.status, to);
    }
    return transitionCase(db, caseId, to, opts);
  }
  await caseEvent(db, caseId, "state_change", (opts.actor as never) ?? "system", {
    from: c.status,
    to,
    reason: opts.reason ?? null,
  });
  return { ...c, status: to, status_reason: opts.reason ?? null };
}

export async function createCase(
  db: D1Database,
  userId: string,
  input: {
    title: string;
    intakeText: string;
    companyId?: string | null;
    companyName?: string | null;
    issueType?: string | null;
    desiredOutcome?: string | null;
    amountCents?: number | null;
    currency?: string | null;
    meta?: Record<string, unknown>;
  },
): Promise<string> {
  const id = newId("case");
  await run(
    db,
    `INSERT INTO cases (id, user_id, company_id, company_name, title, issue_type, desired_outcome, amount_cents, currency, status, intake_text, meta)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    userId,
    input.companyId ?? null,
    input.companyName ?? null,
    input.title,
    input.issueType ?? null,
    input.desiredOutcome ?? null,
    input.amountCents ?? null,
    input.currency ?? "USD",
    "DRAFT",
    input.intakeText,
    input.meta ? JSON.stringify(input.meta) : null,
  );
  await caseEvent(db, id, "case_created", "customer", { title: input.title, intakeText: input.intakeText });
  return id;
}
