import { newId, nowIso } from "./db";

// Append-only event writers. Case events = customer-visible timeline.
// Audit events = operator/security trail (includes security incidents).

export async function caseEvent(
  db: D1Database,
  caseId: string,
  type: string,
  actor: "customer" | "agent" | "merchant" | "system" | "policy",
  data: Record<string, unknown> = {},
): Promise<void> {
  await db
    .prepare("INSERT INTO case_events (id, case_id, type, actor, data_json, created_at) VALUES (?,?,?,?,?,?)")
    .bind(newId("evt"), caseId, type, actor, JSON.stringify(data), nowIso())
    .run();
}

export async function auditEvent(
  db: D1Database,
  opts: {
    userId?: string | null;
    caseId?: string | null;
    type: string;
    severity?: "info" | "warning" | "security" | "error";
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_events (id, user_id, case_id, type, severity, data_json, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(
      newId("aud"),
      opts.userId ?? null,
      opts.caseId ?? null,
      opts.type,
      opts.severity ?? "info",
      JSON.stringify(opts.data ?? {}),
      nowIso(),
    )
    .run();
}

export async function costEvent(
  db: D1Database,
  opts: {
    caseId?: string | null;
    kind: "model" | "browser" | "email" | "storage" | "tool" | "operator";
    provider?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    units?: number;
    unitKind?: "tokens" | "seconds" | "messages" | "bytes";
    costMicroUsd?: number;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cost_events (id, case_id, kind, provider, model, tokens_in, tokens_out, units, unit_kind, cost_micro_usd, meta_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      newId("cost"),
      opts.caseId ?? null,
      opts.kind,
      opts.provider ?? null,
      opts.model ?? null,
      opts.tokensIn ?? null,
      opts.tokensOut ?? null,
      opts.units ?? null,
      opts.unitKind ?? null,
      opts.costMicroUsd ?? null,
      JSON.stringify(opts.meta ?? {}),
      nowIso(),
    )
    .run();
}
