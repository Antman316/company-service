import { json, newId, q1, run } from "./db";

// Shared case_actions plumbing — kept dependency-free so both the agent loop
// and the escalation engine can propose/inspect actions without a module
// cycle between them.

export async function proposeAction(
  db: D1Database,
  caseId: string,
  kind: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  planId?: string | null,
): Promise<string | null> {
  // Idempotent: same logical action never proposed twice.
  const existing = await q1<{ id: string }>(
    db,
    `SELECT id FROM case_actions WHERE idempotency_key = ?`,
    idempotencyKey,
  );
  if (existing) return existing.id;
  const id = newId("act");
  await run(
    db,
    `INSERT INTO case_actions (id, case_id, plan_id, kind, payload_json, policy_class, idempotency_key)
     VALUES (?,?,?,?,?,?,?)`,
    id,
    caseId,
    planId ?? null,
    kind,
    JSON.stringify(payload),
    "AUTO_ALLOWED",
    idempotencyKey,
  );
  return id;
}

export async function nextProposedAction(db: D1Database, caseId: string) {
  return q1<{
    id: string; kind: string; payload_json: string | null; plan_id: string | null;
  }>(
    db,
    `SELECT id, kind, payload_json, plan_id FROM case_actions
     WHERE case_id = ? AND status = 'proposed' ORDER BY created_at ASC LIMIT 1`,
    caseId,
  );
}

export function describeAction(kind: string): string {
  return kind.replace(/_/g, " ");
}

export { json };
