import { json, newId, nowIso, q1, run } from "./db";
import { caseEvent } from "./events";
import type { Mandate } from "./types";

interface MandateRow {
  id: string;
  case_id: string;
  version: number;
  status: string;
  authorized_json: string;
  approval_required_json: string;
  prohibited_json: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

function rowToMandate(r: MandateRow): Mandate {
  return {
    id: r.id,
    case_id: r.case_id,
    version: r.version,
    status: r.status as Mandate["status"],
    authorized: json<string[]>(r.authorized_json, []),
    approvalRequired: json<string[]>(r.approval_required_json, []),
    prohibited: json<string[]>(r.prohibited_json, []),
    expires_at: r.expires_at,
  };
}

export async function getActiveMandate(db: D1Database, caseId: string): Promise<Mandate | null> {
  const r = await q1<MandateRow>(
    db,
    `SELECT * FROM case_mandates WHERE case_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1`,
    caseId,
  );
  if (!r) return null;
  const m = rowToMandate(r);
  if (m.expires_at && new Date(m.expires_at).getTime() < Date.now()) {
    await run(db, `UPDATE case_mandates SET status = 'expired' WHERE id = ?`, m.id);
    m.status = "expired";
    await caseEvent(db, caseId, "mandate_expired", "system", { mandateId: m.id });
    return null;
  }
  return m;
}

export async function getLatestMandate(db: D1Database, caseId: string): Promise<Mandate | null> {
  const r = await q1<MandateRow>(
    db,
    `SELECT * FROM case_mandates WHERE case_id = ? ORDER BY version DESC LIMIT 1`,
    caseId,
  );
  return r ? rowToMandate(r) : null;
}

export async function createMandate(
  db: D1Database,
  caseId: string,
  input: {
    authorized: string[];
    approvalRequired: string[];
    prohibited?: string[];
    expiresAt?: string | null;
  },
): Promise<Mandate> {
  const prev = await getLatestMandate(db, caseId);
  const version = (prev?.version ?? 0) + 1;
  // Supersede any prior active/draft mandate.
  await run(
    db,
    `UPDATE case_mandates SET status = 'revoked', revoked_at = ? WHERE case_id = ? AND status IN ('active','draft')`,
    nowIso(),
    caseId,
  );
  const id = newId("mnd");
  await run(
    db,
    `INSERT INTO case_mandates (id, case_id, version, status, authorized_json, approval_required_json, prohibited_json, expires_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    caseId,
    version,
    "draft",
    JSON.stringify(input.authorized),
    JSON.stringify(input.approvalRequired),
    JSON.stringify(input.prohibited ?? []),
    input.expiresAt ?? null,
  );
  await caseEvent(db, caseId, "mandate_drafted", "customer", {
    mandateId: id,
    version,
    authorized: input.authorized,
    approvalRequired: input.approvalRequired,
  });
  return (await getLatestMandate(db, caseId))!;
}

export async function activateMandate(db: D1Database, caseId: string, mandateId: string): Promise<Mandate | null> {
  const res = await run(
    db,
    `UPDATE case_mandates SET status = 'active' WHERE id = ? AND case_id = ? AND status = 'draft'`,
    mandateId,
    caseId,
  );
  if (res.meta.changes === 0) return null;
  await caseEvent(db, caseId, "mandate_activated", "customer", { mandateId });
  return getLatestMandate(db, caseId);
}

// Revocation is immediate and unconditional: every scheduled/pending work item
// for the case is cancelled here so nothing executes after authority is gone.
export async function revokeMandate(db: D1Database, caseId: string): Promise<void> {
  const now = nowIso();
  await run(
    db,
    `UPDATE case_mandates SET status = 'revoked', revoked_at = ? WHERE case_id = ? AND status = 'active'`,
    now,
    caseId,
  );
  await run(
    db,
    `UPDATE follow_ups SET status = 'cancelled' WHERE case_id = ? AND status = 'pending'`,
    caseId,
  );
  await run(
    db,
    `UPDATE case_actions SET status = 'rejected' WHERE case_id = ? AND status IN ('proposed','awaiting_approval')`,
    caseId,
  );
  await run(
    db,
    `UPDATE approval_requests SET status = 'cancelled', resolved_at = ? WHERE case_id = ? AND status = 'pending'`,
    now,
    caseId,
  );
  await caseEvent(db, caseId, "mandate_revoked", "customer", {});
}
