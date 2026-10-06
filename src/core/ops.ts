import { newId, nowIso, q, q1, run, sha256Hex, addMs } from "./db";
import { auditEvent } from "./events";
import { sendSystemEmail } from "./notify";

// ---------------------------------------------------------------------------
// M9 — ops & reliability primitives.
//
// reportError: every handler catch reports here — audit row + a deduped
//   alert email to the operator (OPS_ALERT_EMAIL, default the org admin
//   mailbox). Native alerting; a real Sentry account remains NOT IMPLEMENTED
//   until Anthony provides a DSN.
// runDailyBackup / backupDue: daily D1 export to R2 as per-table JSONL under
//   backups/<date>/, with a manifest and a retention prune. Restore drill is
//   documented in docs/OPS.md.
// ---------------------------------------------------------------------------

const ALERT_DEDUP_MS = 60 * 60 * 1000; // one alert email per signature per hour

export async function reportError(
  env: Env,
  err: unknown,
  ctx: { route: string; kind?: string; userId?: string; caseId?: string },
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? "").slice(0, 2000) : "";
  const sig = (await sha256Hex(`${ctx.kind ?? "error"}|${ctx.route}|${message.slice(0, 200)}`)).slice(0, 16);
  try {
    await auditEvent(env.DB, {
      userId: ctx.userId ?? null,
      caseId: ctx.caseId ?? null,
      type: "unhandled_error",
      severity: "error",
      data: { sig, route: ctx.route, kind: ctx.kind ?? "error", message: message.slice(0, 500), stack },
    });
  } catch {
    return; // if auditing itself fails, alerting is hopeless too
  }
  // Deduped alert: same signature within the hour → audit only.
  const recent = await q1<{ id: string }>(
    env.DB,
    `SELECT id FROM audit_events
      WHERE type = 'error_alert' AND json_extract(data_json, '$.sig') = ?
        AND created_at > ?`,
    sig,
    addMs(nowIso(), -ALERT_DEDUP_MS),
  ).catch(() => null);
  if (recent) return;
  const to = env.OPS_ALERT_EMAIL ?? "admin@agentmasterkey.com";
  const sent = await sendSystemEmail(
    env,
    to,
    `[Company Service] ${ctx.kind ?? "error"} on ${ctx.route}: ${message.slice(0, 80)}`,
    [
      `An unhandled error was reported.`,
      ``,
      `route: ${ctx.route}`,
      `kind: ${ctx.kind ?? "error"}`,
      `sig: ${sig}`,
      `user: ${ctx.userId ?? "-"}  case: ${ctx.caseId ?? "-"}`,
      ``,
      `error: ${message.slice(0, 500)}`,
      ``,
      `stack:`,
      stack || "(none)",
      ``,
      `Further occurrences of this signature within an hour are audit-only.`,
    ].join("\n"),
  ).catch(() => ({ ok: false, transport: "none", error: "send failed" }));
  await auditEvent(env.DB, {
    type: "error_alert",
    severity: sent.ok ? "warning" : "error",
    data: { sig, route: ctx.route, to, sent: sent.ok, transport: sent.transport, ...(sent.error ? { sendError: sent.error } : {}) },
  }).catch(() => {});
}

// ---- daily backup ---------------------------------------------------------

const BACKUP_PREFIX = "backups/";
const DEFAULT_RETENTION_DAYS = 30;

// Last backup_run audit within 23h → skip (the sweep fires every 5 min).
export async function backupDue(db: D1Database): Promise<boolean> {
  const last = await q1<{ created_at: string }>(
    db,
    `SELECT created_at FROM audit_events WHERE type = 'backup_run' ORDER BY created_at DESC LIMIT 1`,
  );
  if (!last) return true;
  return new Date(last.created_at).getTime() < Date.now() - 23 * 3600 * 1000;
}

export async function runDailyBackup(env: Env): Promise<{ date: string; tables: number; rows: number; pruned: number }> {
  const date = nowIso().slice(0, 10);
  const tables = await q<{ name: string }>(
    env.DB,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'deploy_stage%' ORDER BY name`,
  );
  let total = 0;
  const manifest: Record<string, number> = {};
  for (const t of tables) {
    let offset = 0;
    const lines: string[] = [];
    for (;;) {
      const page = await q<Record<string, unknown>>(env.DB, `SELECT * FROM "${t.name}" LIMIT 500 OFFSET ${offset}`);
      for (const row of page) lines.push(JSON.stringify(row));
      offset += page.length;
      if (page.length < 500) break;
    }
    await env.EVIDENCE.put(`${BACKUP_PREFIX}${date}/${t.name}.jsonl`, lines.join("\n") + (lines.length ? "\n" : ""));
    manifest[t.name] = lines.length;
    total += lines.length;
  }
  await env.EVIDENCE.put(
    `${BACKUP_PREFIX}${date}/manifest.json`,
    JSON.stringify({ generatedAt: nowIso(), environment: env.ENVIRONMENT ?? "unknown", tables: manifest }),
  );

  // Retention: drop backup days older than BACKUP_RETENTION_DAYS (default 30).
  const retention = Number(env.BACKUP_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retention * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const listed = await env.EVIDENCE.list({ prefix: BACKUP_PREFIX, limit: 1000 });
  const stale = (listed.objects ?? []).filter((o) => {
    const day = o.key.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
    return day < cutoff;
  });
  if (stale.length) await env.EVIDENCE.delete(stale.map((o) => o.key));

  await auditEvent(env.DB, {
    type: "backup_run",
    severity: "info",
    data: { date, tables: tables.length, rows: total, pruned: stale.length, retentionDays: retention },
  });
  return { date, tables: tables.length, rows: total, pruned: stale.length };
}

// ---- inbound queue ---------------------------------------------------------

// Queue payload: the whole parsed inbound message plus the R2 key holding the
// raw MIME (attachments can be megabytes — far over the 128KB queue-message
// limit, so only a pointer rides the queue).
export interface InboundQueueMessage {
  r2Key: string;
  caseId: string | null; // null for forward-to-start mail (case created by the consumer)
  enqueuedAt: string;
}

export const INBOUND_RAW_PREFIX = "inbound-raw/";

export function inboundRawKey(): string {
  return `${INBOUND_RAW_PREFIX}${newId("eml")}`;
}

// ---- per-follow-up workflow arming -----------------------------------------

// Arm a CaseWorkflow instance for a freshly-scheduled follow-up. Optional:
// when the binding isn't configured (local tests, older deploys) the cron
// sweep covers the same rows, so failure here is audit-only.
export async function armFollowUpWorkflow(env: Env, followUpId: string, caseId: string): Promise<void> {
  const wf = (env as { CASE_WORKFLOW?: Workflow<{ followUpId: string; caseId: string }> }).CASE_WORKFLOW;
  if (!wf) return;
  try {
    await wf.create({ id: `wf_${followUpId}`, params: { followUpId, caseId } });
  } catch (e) {
    await reportError(env, e, { route: "workflow/arm", kind: "case_workflow", caseId }).catch(() => {});
  }
}
