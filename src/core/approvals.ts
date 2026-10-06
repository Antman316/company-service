import { json, newId, nowIso, q, q1, run } from "./db";
import { caseEvent } from "./events";
import { notify } from "./notify";
import type { ApprovalOption } from "./types";

export interface ApprovalRequestRow {
  id: string;
  case_id: string;
  action_id: string | null;
  kind: string;
  summary: string;
  detail_json: string | null;
  options_json: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolved_option: string | null;
  resolver: string | null;
}

export async function createApproval(
  env: Env,
  caseId: string,
  opts: {
    actionId?: string;
    kind: string;
    summary: string;
    detail?: Record<string, unknown>;
    options: ApprovalOption[];
  },
): Promise<string> {
  const db = env.DB;
  const id = newId("apr");
  await run(
    db,
    `INSERT INTO approval_requests (id, case_id, action_id, kind, summary, detail_json, options_json)
     VALUES (?,?,?,?,?,?,?)`,
    id,
    caseId,
    opts.actionId ?? null,
    opts.kind,
    opts.summary,
    JSON.stringify(opts.detail ?? {}),
    JSON.stringify(opts.options),
  );
  await caseEvent(db, caseId, "approval_created", "system", {
    approvalId: id,
    kind: opts.kind,
    summary: opts.summary,
  });
  // M7: email the customer that a decision is waiting (preference-gated).
  const caseRow = await q1<{ user_id: string; company_name: string | null }>(
    db, `SELECT user_id, company_name FROM cases WHERE id = ?`, caseId,
  );
  if (caseRow) {
    await notify(env, caseRow.user_id, "approval_needed", {
      caseId,
      subject: `Company Service needs your decision${caseRow.company_name ? ` — ${caseRow.company_name}` : ""}`,
      body: `${opts.summary}\n\nOpen the app to review and decide.`,
    }).catch(() => {});
  }
  return id;
}

export async function decideApproval(
  db: D1Database,
  approvalId: string,
  optionId: string,
  resolver: string,
): Promise<{ ok: boolean; error?: string; option?: ApprovalOption }> {
  const row = await q1<ApprovalRequestRow>(
    db,
    `SELECT * FROM approval_requests WHERE id = ?`,
    approvalId,
  );
  if (!row) return { ok: false, error: "approval not found" };
  if (row.status !== "pending") return { ok: false, error: `approval already ${row.status}` };
  const options = json<ApprovalOption[]>(row.options_json, []);
  const option = options.find((o) => o.id === optionId);
  if (!option) return { ok: false, error: "unknown option" };

  const status = option.kind === "approve" ? "approved" : option.kind === "reject" ? "rejected" : "approved";
  await run(
    db,
    `UPDATE approval_requests SET status = ?, resolved_at = ?, resolved_option = ?, resolver = ? WHERE id = ? AND status = 'pending'`,
    status,
    nowIso(),
    optionId,
    resolver,
    approvalId,
  );
  await caseEvent(db, row.case_id, "approval_decided", "customer", {
    approvalId,
    optionId,
    label: option.label,
    status,
  });
  return { ok: true, option };
}

export async function pendingApprovals(db: D1Database, userId: string): Promise<ApprovalRequestRow[]> {
  return q<ApprovalRequestRow>(
    db,
    `SELECT a.* FROM approval_requests a JOIN cases c ON c.id = a.case_id
     WHERE c.user_id = ? AND a.status = 'pending' ORDER BY a.created_at DESC`,
    userId,
  );
}
