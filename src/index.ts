import {
  advanceCase,
  createCaseFromText,
  ensureConversation,
  handleApprovalDecision,
  ingestMerchantMessage,
  runFollowUpSweep,
  suggestedMandate,
} from "./core/agent";
import { decideApproval, pendingApprovals } from "./core/approvals";
import { getCase, transitionCase } from "./core/caseEngine";
import { addEvidence, claimView, evidenceView, listClaims, listEvidence } from "./core/evidence";
import { addMs, json, nowIso, q, q1, run } from "./core/db";
import { caseEvent, auditEvent } from "./core/events";
import { cancelFollowUps, scheduleFollowUp } from "./core/followups";
import { activateMandate, createMandate, getLatestMandate, revokeMandate } from "./core/mandate";
import { latestOutcome } from "./core/outcomes";
import { seedRegistry } from "./adapters/registry";
import { extractMessageIds, resolveInboundCase } from "./email/threading";
import PostalMime from "postal-mime";
import { encryptJson } from "./security/crypto";
import { getSession, requireCsrf, signin, signout, signup } from "./http/auth";
import { STATIC_FILES } from "./static";

// --------------------------------------------------------------------------
// Tiny JSON router — /api/* is the product API; everything else falls through
// to static assets (the React SPA).
// --------------------------------------------------------------------------

function res(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}
const err = (status: number, error: string) => res({ error }, { status });

type Ctx = { env: Env; url: URL; session: { userId: string; csrf: string; token: string } | null };

async function api(req: Request, ctx: Ctx): Promise<Response> {
  const { env, url } = ctx;
  const path = url.pathname;
  const secure = url.protocol === "https:";

  // ---- auth (unauthenticated) ----
  if (path === "/api/auth/signup" && req.method === "POST") {
    const b = (await req.json()) as { email?: string; password?: string };
    const r = await signup(env.DB, b.email ?? "", b.password ?? "");
    if (!r.ok) return err(400, r.error);
    const s = await signin(env.DB, b.email!, b.password!, secure);
    if (!s.ok) return err(500, "auto sign-in failed");
    return res({ ok: true, csrf: s.csrf }, { headers: { "Set-Cookie": s.cookie } });
  }
  if (path === "/api/auth/signin" && req.method === "POST") {
    const b = (await req.json()) as { email?: string; password?: string };
    const s = await signin(env.DB, b.email ?? "", b.password ?? "", secure);
    if (!s.ok) return err(401, s.error);
    return res({ ok: true, csrf: s.csrf }, { headers: { "Set-Cookie": s.cookie } });
  }
  if (path === "/api/health") return res({ ok: true, service: "company-service", time: nowIso() });

  const session = ctx.session;
  if (!session) return err(401, "not signed in");
  if (!requireCsrf(req, session)) return err(403, "csrf token missing or invalid");
  const uid = session.userId;

  if (path === "/api/auth/signout" && req.method === "POST") {
    const cookie = await signout(env.DB, session.token, secure);
    return res({ ok: true }, { headers: { "Set-Cookie": cookie } });
  }
  if (path === "/api/auth/me") {
    const user = await q1<{ id: string; email: string; created_at: string }>(
      env.DB, `SELECT id, email, created_at FROM users WHERE id = ?`, uid);
    return res({ user, csrf: session.csrf });
  }

  // ---- cases ----
  if (path === "/api/cases" && req.method === "GET") {
    const cases = await q(
      env.DB,
      `SELECT id, title, company_name, issue_type, status, status_reason, desired_outcome, amount_cents, currency, paused, created_at, updated_at
       FROM cases WHERE user_id = ? ORDER BY updated_at DESC`,
      uid,
    );
    const pending = await pendingApprovals(env.DB, uid);
    return res({ cases, pendingApprovals: pending.length });
  }
  if (path === "/api/cases" && req.method === "POST") {
    const b = (await req.json()) as { text?: string; scenario?: string };
    if (!b.text || b.text.trim().length < 5) return err(400, "describe the problem in a sentence or two");
    const { caseId, objective } = await createCaseFromText(env, uid, b.text.trim());
    if (b.scenario) {
      await run(env.DB, `UPDATE cases SET meta = json_set(COALESCE(meta, '{}'), '$.scenario', ?) WHERE id = ?`, b.scenario, caseId);
    }
    await caseEvent(env.DB, caseId, "intake_completed", "agent", { objective });
    return res({ caseId, objective, suggestedMandate: suggestedMandate(objective) });
  }

  const caseMatch = path.match(/^\/api\/cases\/([^/]+)(\/.*)?$/);
  if (caseMatch) {
    const caseId = caseMatch[1]!;
    const sub = caseMatch[2] ?? "";
    const owned = await q1<{ id: string }>(env.DB, `SELECT id FROM cases WHERE id = ? AND user_id = ?`, caseId, uid);
    if (!owned) return err(404, "case not found");

    if (sub === "" && req.method === "GET") {
      return res(await caseDetail(env, caseId));
    }
    if (sub === "/evidence" && req.method === "POST") {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("multipart/form-data")) {
        const form = await req.formData();
        const file = form.get("file");
        const label = (form.get("label") as string) || (file instanceof File ? file.name : null);
        const kind = (form.get("kind") as string) || "receipt";
        if (file instanceof File) {
          if (file.size > MAX_EVIDENCE_BYTES) return err(413, `file too large (max ${MAX_EVIDENCE_BYTES / 1e6}MB)`);
          if (!EVIDENCE_MIME_ALLOW.has(file.type)) {
            return err(415, `unsupported file type: ${file.type || "unknown"}`);
          }
          const id = await addEvidence(env.DB, env, caseId, {
            kind: kind as never, blob: await file.arrayBuffer(), mime: file.type, label: label ?? undefined,
          });
          return res({ id });
        }
        return err(400, "no file in upload");
      }
      const b = (await req.json()) as { kind?: string; text?: string; label?: string };
      if (!b.text) return err(400, "text required for non-file evidence");
      const id = await addEvidence(env.DB, env, caseId, {
        kind: (b.kind as never) ?? "note", text: b.text, label: b.label,
      });
      return res({ id });
    }
    const evFileMatch = sub.match(/^\/evidence\/([^/]+)\/file$/);
    if (evFileMatch && req.method === "GET") {
      const ev = await q1<{ r2_key: string | null; mime: string | null }>(
        env.DB, `SELECT r2_key, mime FROM case_evidence WHERE id = ? AND case_id = ?`, evFileMatch[1], caseId);
      if (!ev?.r2_key || !env.EVIDENCE) return err(404, "file not found");
      const obj = await env.EVIDENCE.get(ev.r2_key);
      if (!obj) return err(404, "file not found in storage");
      // Download-only + nosniff: stored customer files are never rendered
      // inline by the site, so an uploaded HTML/SVG can't run script.
      return new Response(obj.body, {
        headers: {
          "Content-Type": ev.mime ?? "application/octet-stream",
          "Content-Disposition": "attachment",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        },
      });
    }
    if (sub === "/assisted/sent" && req.method === "POST") {
      // Customer carried the drafted message through the assisted channel.
      const act = await q1<{ id: string }>(
        env.DB,
        `SELECT id FROM case_actions WHERE case_id = ? AND status = 'awaiting_customer' ORDER BY created_at DESC LIMIT 1`,
        caseId,
      );
      if (!act) return err(409, "no assisted step is waiting on you");
      await run(env.DB, `UPDATE case_actions SET status='executed', executed_at=? WHERE id=?`, nowIso(), act.id);
      await caseEvent(env.DB, caseId, "assisted_sent", "customer", { actionId: act.id });
      await transitionCase(env.DB, caseId, "WAITING_FOR_COMPANY", { reason: "customer sent assisted message", actor: "customer" });
      // Wake the case if the merchant never replies.
      await scheduleFollowUp(env.DB, caseId, "send_followup", addMs(nowIso(), 2 * 24 * 3600 * 1000), { via: "assisted" });
      return res({ ok: true });
    }
    if (sub === "/assisted/reply" && req.method === "POST") {
      const b = (await req.json()) as { body?: string };
      if (!b.body?.trim()) return err(400, "paste the reply you received");
      const caseRow = await getCase(env.DB, caseId);
      if (!caseRow) return err(404, "case not found");
      const conv = await q1<{ id: string }>(
        env.DB,
        `SELECT id FROM external_conversations WHERE case_id = ? ORDER BY created_at DESC LIMIT 1`,
        caseId,
      );
      const convId = conv?.id ?? (await ensureConversation(env.DB, caseId, "chat", "assisted"));
      // The pasted reply is merchant-originated: same untrusted ingest path as
      // email — injection screened, evidence provenance, policy gating.
      await ingestMerchantMessage(env, caseRow, convId, b.body.trim(), {
        meta: { transport: "assisted", pastedBy: "customer" },
      });
      const outcome = await advanceCase(env, caseId, "assisted_reply");
      return res({ ok: true, case: outcome });
    }
    if (sub === "/mandate" && req.method === "POST") {
      const b = (await req.json()) as {
        authorized?: string[]; approvalRequired?: string[]; prohibited?: string[]; expiresAt?: string;
      };
      if (!b.authorized?.length) return err(400, "mandate must authorize at least one capability");
      const m = await createMandate(env.DB, caseId, {
        authorized: b.authorized, approvalRequired: b.approvalRequired ?? [],
        prohibited: b.prohibited ?? [], expiresAt: b.expiresAt ?? null,
      });
      await activateMandate(env.DB, caseId, m.id);
      // Kicks the case: mandate granted -> agent may proceed.
      const outcome = await advanceCase(env, caseId, "mandate_activated");
      return res({ mandate: m, case: outcome });
    }
    if (sub === "/mandate/revoke" && req.method === "POST") {
      await revokeMandate(env.DB, caseId);
      await auditEvent(env.DB, { userId: uid, caseId, type: "authority_revoked", severity: "info" });
      return res({ ok: true });
    }
    if (sub === "/pause" && req.method === "POST") {
      // Pause freezes work without destroying it: the sweep skips paused cases
      // and pending follow-ups stay pending until resume.
      await run(env.DB, `UPDATE cases SET paused = 1, updated_at = ? WHERE id = ?`, nowIso(), caseId);
      await caseEvent(env.DB, caseId, "case_paused", "customer", {});
      return res({ ok: true });
    }
    if (sub === "/resume" && req.method === "POST") {
      await run(env.DB, `UPDATE cases SET paused = 0, updated_at = ? WHERE id = ?`, nowIso(), caseId);
      await caseEvent(env.DB, caseId, "case_resumed", "customer", {});
      const outcome = await advanceCase(env, caseId, "resumed");
      return res({ ok: true, case: outcome });
    }
    if (sub === "/cancel" && req.method === "POST") {
      await revokeMandate(env.DB, caseId);
      await cancelFollowUps(env.DB, caseId);
      await transitionCase(env.DB, caseId, "CANCELLED", { reason: "cancelled by customer", actor: "customer" });
      return res({ ok: true });
    }
    if (sub === "/run" && req.method === "POST") {
      const outcome = await advanceCase(env, caseId, "manual_run");
      return res(outcome);
    }
    if (sub === "/message" && req.method === "POST") {
      const b = (await req.json()) as { text?: string };
      if (!b.text?.trim()) return err(400, "text required");
      await addEvidence(env.DB, env, caseId, { kind: "note", text: b.text.trim(), label: "Customer note" });
      await caseEvent(env.DB, caseId, "customer_note", "customer", { text: b.text.trim().slice(0, 300) });
      // A note can unblock NEEDS_INFORMATION/WAITING_FOR_CUSTOMER cases.
      const c = await getCase(env.DB, caseId);
      if (c?.status === "NEEDS_INFORMATION" || c?.status === "WAITING_FOR_CUSTOMER") {
        await transitionCase(env.DB, caseId, "IN_PROGRESS", { reason: "customer provided information", actor: "customer" });
        const outcome = await advanceCase(env, caseId, "customer_note");
        return res({ ok: true, case: outcome });
      }
      return res({ ok: true });
    }
  }

  // ---- approvals ----
  if (path === "/api/approvals" && req.method === "GET") {
    const approvals = await pendingApprovals(env.DB, uid);
    return res({
      approvals: approvals.map((a) => ({
        id: a.id, caseId: a.case_id, kind: a.kind, summary: a.summary,
        detail: json(a.detail_json, {}), options: json(a.options_json, []),
        createdAt: a.created_at,
      })),
    });
  }
  const aprMatch = path.match(/^\/api\/approvals\/([^/]+)\/decide$/);
  if (aprMatch && req.method === "POST") {
    const b = (await req.json()) as { optionId?: string };
    // Ownership check via case join.
    const row = await q1<{ case_id: string }>(
      env.DB,
      `SELECT a.case_id FROM approval_requests a JOIN cases c ON c.id = a.case_id WHERE a.id = ? AND c.user_id = ?`,
      aprMatch[1], uid);
    if (!row) return err(404, "approval not found");
    const r = await decideApproval(env.DB, aprMatch[1]!, b.optionId ?? "", uid);
    if (!r.ok) return err(400, r.error ?? "decision failed");
    await handleApprovalDecision(env, aprMatch[1]!);
    return res({ ok: true });
  }

  // ---- connections ----
  if (path === "/api/connections") {
    if (req.method === "GET") {
      const rows = await q(
        env.DB,
        `SELECT id, type, provider, label, status, meta, created_at FROM connections WHERE user_id = ? ORDER BY created_at DESC`,
        uid,
      );
      return res({
        connections: rows.map((r: Record<string, unknown>) => ({
          id: r.id, type: r.type, provider: r.provider, label: r.label,
          status: r.status, meta: json(r.meta as string | null, {}), createdAt: r.created_at,
        })),
      });
    }
    if (req.method === "POST") {
      const b = (await req.json()) as {
        type?: string; provider?: string; label?: string; config?: Record<string, string>;
      };
      if (!b.type || !b.provider || !b.label) return err(400, "type, provider, label required");
      if (!env.SECRET_KEY) return err(500, "secret store unavailable");
      const id = `conn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      const enc = b.config && Object.keys(b.config).length > 0
        ? await encryptJson(b.config, env.SECRET_KEY)
        : null;
      await run(
        env.DB,
        `INSERT INTO connections (id, user_id, type, provider, label, status, config_enc, meta) VALUES (?,?,?,?,?,?,?,?)`,
        id, uid, b.type, b.provider, b.label, "active", enc,
        JSON.stringify({ keys: Object.keys(b.config ?? {}) }),
      );
      await auditEvent(env.DB, { userId: uid, type: "connection_created", data: { provider: b.provider, type: b.type } });
      return res({ id });
    }
  }
  const connMatch = path.match(/^\/api\/connections\/([^/]+)(\/test)?$/);
  if (connMatch) {
    const owned = await q1<{ id: string; type: string; provider: string; config_enc: string | null }>(
      env.DB, `SELECT * FROM connections WHERE id = ? AND user_id = ?`, connMatch[1], uid);
    if (!owned) return err(404, "connection not found");
    if (connMatch[2] === "/test" && req.method === "POST") {
      if (owned.type !== "model_provider") return res({ ok: true, detail: "health check not applicable" });
      const { resolveProvider } = await import("./providers/registry");
      const { provider } = await resolveProvider(env, { userId: uid });
      const health = await provider.healthCheck();
      return res({ providerId: provider.id, ...health });
    }
    if (req.method === "DELETE") {
      // Revocation wipes stored credentials — "revoked" is not just a flag.
      await run(env.DB, `UPDATE connections SET status = 'revoked', config_enc = NULL, updated_at = ? WHERE id = ?`, nowIso(), owned.id);
      await auditEvent(env.DB, { userId: uid, type: "connection_revoked", data: { connectionId: owned.id } });
      return res({ ok: true });
    }
  }

  // ---- customer data control ----
  if (path === "/api/account/export" && req.method === "GET") {
    return res(await exportAccount(env, uid));
  }
  if (path === "/api/account/delete" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { confirm?: string };
    if (b.confirm !== "DELETE") return err(400, "confirm with {\"confirm\":\"DELETE\"}");
    await deleteAccount(env, uid, session.token);
    return res({ ok: true }, { headers: { "Set-Cookie": `cs_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` } });
  }

  // ---- coverage registry ----
  if (path === "/api/coverage" && req.method === "GET") {
    const companies = await q(env.DB, `SELECT * FROM companies ORDER BY name`);
    const coverage = await q(env.DB, `SELECT * FROM company_coverage ORDER BY company_id`);
    return res({ companies, coverage });
  }

  // ---- economics ----
  if (path === "/api/economics" && req.method === "GET") {
    const cases = await q<{ status: string; n: number }>(
      env.DB, `SELECT status, COUNT(*) n FROM cases WHERE user_id = ? GROUP BY status`, uid);
    const costs = await q<{ case_id: string; kind: string; cost: number; units: number }>(
      env.DB,
      `SELECT case_id, kind, COALESCE(SUM(cost_micro_usd),0) cost, COALESCE(SUM(units),0) units
       FROM cost_events WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?) GROUP BY case_id, kind`,
      uid);
    const agg = await q1<{ total: number; cases: number }>(
      env.DB,
      `SELECT COALESCE(SUM(cost_micro_usd),0) total, COUNT(DISTINCT case_id) cases
       FROM cost_events WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`, uid);
    const approvals = await q1<{ n: number }>(
      env.DB,
      `SELECT COUNT(*) n FROM approval_requests a JOIN cases c ON c.id = a.case_id WHERE c.user_id = ?`, uid);
    const followups = await q1<{ n: number; fired: number }>(
      env.DB,
      `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN f.status = 'fired' THEN 1 ELSE 0 END),0) fired
       FROM follow_ups f JOIN cases c ON c.id = f.case_id WHERE c.user_id = ?`, uid);
    const byProvider = await q<{ provider: string; n: number; cost: number }>(
      env.DB,
      `SELECT COALESCE(provider,'(none)') provider, COUNT(*) n, COALESCE(SUM(cost_micro_usd),0) cost
       FROM cost_events WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?) GROUP BY provider`, uid);
    return res({
      casesByStatus: cases,
      costsByCase: costs,
      totalMicroUsd: agg?.total ?? 0,
      casesWithCost: agg?.cases ?? 0,
      approvalsTotal: approvals?.n ?? 0,
      followUpsTotal: followups?.n ?? 0,
      followUpsFired: followups?.fired ?? 0,
      byProvider,
    });
  }

  // ---- demo inbound email (dev/test only) ----
  if (path === "/api/sim/inbound" && req.method === "POST") {
    if (env.ENVIRONMENT === "production") return err(403, "simulation disabled in production");
    const b = (await req.json()) as { to?: string; subject?: string; body?: string; from?: string };
    const caseId = await resolveInboundCase(env.DB, { to: b.to ?? "", subject: b.subject ?? "" });
    if (!caseId) return err(404, "no case matched inbound message");
    await ingestInboundText(env, caseId, b.body ?? "");
    return res({ ok: true, caseId });
  }

  return err(404, "not found");
}

async function caseDetail(env: Env, caseId: string) {
  const c = await getCase(env.DB, caseId);
  const meta = json<{ orderRef?: string; trackingRef?: string; scenario?: string }>((c as Record<string, unknown> | null)?.meta as string | null, {});
  const [claims, evidence, events, messages, mandate, outcome, approvals, actions, followups, costs] =
    await Promise.all([
      listClaims(env.DB, caseId),
      listEvidence(env.DB, caseId),
      q(env.DB, `SELECT * FROM case_events WHERE case_id = ? ORDER BY created_at ASC, rowid ASC`, caseId),
      q(env.DB,
        `SELECT m.*, c.channel, c.adapter_id FROM external_messages m
         JOIN external_conversations c ON c.id = m.conversation_id
         WHERE c.case_id = ? ORDER BY m.created_at ASC`, caseId),
      getLatestMandate(env.DB, caseId),
      latestOutcome(env.DB, caseId),
      q(env.DB, `SELECT * FROM approval_requests WHERE case_id = ? ORDER BY created_at DESC`, caseId),
      q(env.DB, `SELECT * FROM case_actions WHERE case_id = ? ORDER BY created_at ASC`, caseId),
      q(env.DB, `SELECT * FROM follow_ups WHERE case_id = ? ORDER BY due_at ASC`, caseId),
      q(env.DB, `SELECT kind, COUNT(*) n, SUM(cost_micro_usd) cost FROM cost_events WHERE case_id = ? GROUP BY kind`, caseId),
    ]);
  return {
    case: c,
    orderRef: meta.orderRef ?? null,
    trackingRef: meta.trackingRef ?? null,
    claims: claims.map((r: Record<string, unknown>) => claimView(r)),
    evidence: evidence.map((r: Record<string, unknown>) => evidenceView(r)),
    events: events.map((r: Record<string, unknown>) => ({
      id: r.id, type: r.type, actor: r.actor, data: json(r.data_json as string | null, {}), at: r.created_at,
    })),
    messages: messages.map((r: Record<string, unknown>) => ({
      id: r.id, direction: r.direction, subject: r.subject, body: r.body,
      channel: r.channel, status: r.status, at: r.created_at,
    })),
    mandate,
    outcome,
    approvals: approvals.map((r: Record<string, unknown>) => ({
      id: r.id, kind: r.kind, summary: r.summary, status: r.status,
      options: json(r.options_json as string | null, []), createdAt: r.created_at,
      resolvedOption: r.resolved_option, resolvedAt: r.resolved_at,
    })),
    actions: actions.map((r: Record<string, unknown>) => ({
      id: r.id, kind: r.kind, policyClass: r.policy_class, status: r.status,
      executedAt: r.executed_at, error: r.error,
    })),
    followUps: followups.map((r: Record<string, unknown>) => ({
      id: r.id, kind: r.kind, dueAt: r.due_at, status: r.status, firedAt: r.fired_at,
    })),
    costs,
    ...(await assistedLane(env.DB, caseId)),
  };
}

// Assisted-lane state for the UI: `assisted` is the pending drafted step (if
// any); `assistedLane` stays true once the case has run an assisted send so the
// reply box survives the "I sent it" transition — merchant replies arrive late.
async function assistedLane(db: D1Database, caseId: string) {
  const row = await q1<{ id: string; result_json: string | null; created_at: string }>(
    db,
    `SELECT id, result_json, created_at FROM case_actions WHERE case_id = ? AND status = 'awaiting_customer' ORDER BY created_at DESC LIMIT 1`,
    caseId,
  );
  const assisted = row
    ? (() => {
        const r = json<{ draft?: string; target?: string | null }>(row.result_json, {});
        return { actionId: row.id, draft: r.draft ?? "", target: r.target ?? "the merchant's support page", createdAt: row.created_at };
      })()
    : null;
  const laneOpen = assisted !== null || (await q1<{ id: string }>(
    db,
    `SELECT m.id FROM external_messages m JOIN external_conversations c ON c.id = m.conversation_id
     WHERE c.case_id = ? AND m.meta_json LIKE '%"assisted"%' LIMIT 1`,
    caseId,
  )) !== null;
  return { assisted, assistedLane: laneOpen };
}


// Evidence upload guardrails: generous but bounded, and never executable.
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const EVIDENCE_MIME_ALLOW = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "application/pdf", "text/plain", "text/csv", "message/rfc822",
]);

// Limits for inbound email attachments (merchant-originated, least trust).
const MAX_ATTACH_BYTES = 5 * 1024 * 1024;
const MAX_ATTACH_TOTAL = 15 * 1024 * 1024;

async function ingestInboundText(
  env: Env,
  caseId: string,
  body: string,
  opts?: { subject?: string; meta?: Record<string, unknown>; externalId?: string | null },
) {
  const caseRow = await getCase(env.DB, caseId);
  if (!caseRow) return;
  const conv = await q1<{ id: string }>(
    env.DB,
    `SELECT id FROM external_conversations WHERE case_id = ? ORDER BY created_at DESC LIMIT 1`,
    caseId,
  );
  const convId = conv?.id ?? (await ensureConversation(env.DB, caseId, "email", "inbound"));
  await ingestMerchantMessage(env, caseRow, convId, body, opts);
}

// Full inbound pipeline for a parsed email (Email Routing handler + tests).
// Returns 'processed' | 'duplicate' | 'rejected'. Rejected mail is bounced back
// to the sender by setReject in the caller.
export async function ingestInboundEmail(
  env: Env,
  parsed: {
    to: string;
    from?: string;
    subject?: string;
    body: string;
    messageId?: string | null;
    inReplyTo?: string | null;
    references?: string | string[] | null;
    attachments?: { filename: string; mimeType: string; content: ArrayBuffer | Uint8Array }[];
  },
): Promise<{ result: string; caseId?: string }> {
  const inboundDomain = env.INBOUND_ADDRESS?.split("@")[1] ?? env.EMAIL_DOMAIN ?? "agentmasterkey.com";

  // Domain guard: only mail addressed to our inbound domain is case mail.
  if (!parsed.to.toLowerCase().endsWith(`@${inboundDomain}`)) {
    await auditEvent(env.DB, { type: "inbound_wrong_domain", severity: "warning", data: { to: parsed.to } });
    return { result: "rejected" };
  }

  // Idempotent: the same RFC message-id is never ingested twice, even if Email
  // Routing retries delivery.
  if (parsed.messageId) {
    const dup = await q1<{ id: string }>(
      env.DB,
      `SELECT id FROM external_messages WHERE external_id = ? LIMIT 1`,
      parsed.messageId,
    );
    if (dup) {
      await auditEvent(env.DB, { type: "inbound_duplicate", severity: "info", data: { messageId: parsed.messageId } });
      return { result: "duplicate" };
    }
  }

  const threadIds = extractMessageIds([
    parsed.inReplyTo ?? undefined,
    parsed.references ?? undefined,
    parsed.messageId ?? undefined,
  ]);
  const caseId = await resolveInboundCase(env.DB, {
    to: parsed.to,
    subject: parsed.subject ?? "",
    messageIds: threadIds,
  });
  if (!caseId) {
    await auditEvent(env.DB, { type: "inbound_unmatched", severity: "warning", data: { to: parsed.to, subject: parsed.subject } });
    return { result: "rejected" };
  }

  // Sender/recipient metadata is retained with the message — audit trail.
  await ingestInboundText(env, caseId, parsed.body || "(no body)", {
    subject: parsed.subject ?? "",
    externalId: parsed.messageId ?? null,
    meta: {
      channel: "email",
      from: parsed.from ?? "",
      to: parsed.to,
      messageId: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
      receivedVia: "cloudflare_email_routing",
    },
  });

  // Attachments: bounded, hashed, stored under randomized case-scoped keys,
  // provenance=merchant. Oversized/skipped ones are still noted for the trail.
  let total = 0;
  for (const att of parsed.attachments ?? []) {
    const bytes = att.content instanceof Uint8Array ? att.content : new Uint8Array(att.content);
    total += bytes.byteLength;
    const mimeOk = EVIDENCE_MIME_ALLOW.has(att.mimeType) || att.mimeType === "message/rfc822";
    if (bytes.byteLength > MAX_ATTACH_BYTES || total > MAX_ATTACH_TOTAL || !mimeOk) {
      await caseEvent(env.DB, caseId, "attachment_skipped", "system", {
        filename: att.filename, sizeBytes: bytes.byteLength,
        reason: !mimeOk ? "mime not allowed" : "size limit",
      });
      continue;
    }
    const kind = att.mimeType.startsWith("image/") ? "image" : att.mimeType === "application/pdf" ? "pdf" : "email";
    await addEvidence(env.DB, env, caseId, {
      kind: kind as never,
      blob: bytes,
      mime: att.mimeType,
      source: "merchant",
      label: `Email attachment: ${att.filename}`,
    });
  }
  return { result: "processed", caseId };
}

// ---------------------------------------------------------------------------
// Customer data control: full export + full delete. Retention: nothing is
// kept beyond the user relationship in V1 — audit rows tied to the user are
// removed too (documented in docs/SECURITY.md).
// ---------------------------------------------------------------------------

async function exportAccount(env: Env, uid: string) {
  const tables: [string, string][] = [
    ["cases", `SELECT * FROM cases WHERE user_id = ?`],
    ["case_claims", `SELECT * FROM case_claims WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`],
    ["case_evidence", `SELECT id, case_id, kind, text, mime, size_bytes, sha256, source, label, created_at FROM case_evidence WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`],
    ["external_conversations", `SELECT * FROM external_conversations WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`],
    ["external_messages", `SELECT m.* FROM external_messages m JOIN external_conversations c ON c.id = m.conversation_id WHERE c.case_id IN (SELECT id FROM cases WHERE user_id = ?)`],
    ["case_mandates", `SELECT * FROM case_mandates WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`],
    ["approval_requests", `SELECT a.* FROM approval_requests a JOIN cases c ON c.id = a.case_id WHERE c.user_id = ?`],
    ["case_events", `SELECT * FROM case_events WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`],
    ["outcome_events", `SELECT * FROM outcome_events WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`],
    ["follow_ups", `SELECT f.* FROM follow_ups f JOIN cases c ON c.id = f.case_id WHERE c.user_id = ?`],
    ["case_actions", `SELECT * FROM case_actions WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`],
    ["case_plans", `SELECT * FROM case_plans WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`],
    ["connections", `SELECT id, type, provider, label, status, meta, created_at FROM connections WHERE user_id = ?`],
  ];
  const out: Record<string, unknown> = {
    exportedAt: nowIso(),
    user: await q1(env.DB, `SELECT id, email, created_at FROM users WHERE id = ?`, uid),
  };
  for (const [name, sql] of tables) out[name] = await q(env.DB, sql, uid);
  return out;
}

async function deleteAccount(env: Env, uid: string, sessionToken: string) {
  // Evidence objects in R2 first (they're the biggest + hardest to re-create).
  if (env.EVIDENCE) {
    const keys = await q<{ r2_key: string }>(
      env.DB,
      `SELECT r2_key FROM case_evidence WHERE r2_key IS NOT NULL AND case_id IN (SELECT id FROM cases WHERE user_id = ?)`,
      uid,
    );
    for (const k of keys) await env.EVIDENCE.delete(k.r2_key).catch(() => undefined);
  }
  const del = async (sql: string) => run(env.DB, sql, uid);
  await del(`DELETE FROM external_messages WHERE conversation_id IN (SELECT id FROM external_conversations WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?))`);
  await del(`DELETE FROM external_conversations WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`);
  await del(`DELETE FROM case_evidence WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`);
  await del(`DELETE FROM case_claims WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`);
  await del(`DELETE FROM case_actions WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`);
  await del(`DELETE FROM case_plans WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`);
  await del(`DELETE FROM case_mandates WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`);
  await del(`DELETE FROM approval_requests WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`);
  await del(`DELETE FROM follow_ups WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`);
  await del(`DELETE FROM outcome_events WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`);
  await del(`DELETE FROM case_events WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`);
  await del(`DELETE FROM cost_events WHERE case_id IN (SELECT id FROM cases WHERE user_id = ?)`);
  await del(`DELETE FROM cases WHERE user_id = ?`);
  await del(`DELETE FROM connections WHERE user_id = ?`);
  await del(`DELETE FROM sessions WHERE user_id = ?`);
  await del(`DELETE FROM audit_events WHERE user_id = ?`);
  await run(env.DB, `DELETE FROM users WHERE id = ?`, uid);
  void sessionToken;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      await seedRegistry(env.DB);
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) {
        const session = await getSession(req, env.DB);
        return await api(req, { env, url, session });
      }
      // SPA: prefer the ASSETS binding when present; otherwise serve the
      // inlined build (scripts/gen-static.mjs) — used when the assets upload
      // API isn't reachable from the deploy path.
      if (env.ASSETS) return env.ASSETS.fetch(req);
      const asset = STATIC_FILES[url.pathname];
      if (asset) {
        const bytes = Uint8Array.from(atob(asset.body), (ch) => ch.charCodeAt(0));
        return new Response(bytes, {
          headers: { "content-type": asset.type, "cache-control": url.pathname === "/index.html" ? "no-store" : "public, max-age=31536000, immutable" },
        });
      }
      const index = STATIC_FILES["/index.html"];
      if (index) {
        return new Response(Uint8Array.from(atob(index.body), (ch) => ch.charCodeAt(0)), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return new Response("Company Service", { status: 200 });
    } catch (e) {
      console.error("unhandled", e);
      return err(500, "internal error");
    }
  },

  // Durable follow-up sweep — the "customer never has to remember" engine.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runFollowUpSweep(env).then((r) => console.log(`[sweep] fired=${r.fired}`)));
  },

  // Inbound email via Cloudflare Email Routing (real public route — a literal
  // rule on the zone points env.INBOUND_ADDRESS at this handler). Proper MIME
  // decode via postal-mime; ingestInboundEmail handles domain guard, message-id
  // dedup, case resolution, metadata retention, attachments, and the untrusted
  // content pipeline.
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const parsed = await PostalMime.parse(message.raw);
      const to = parsed.to?.[0]?.address ?? message.to ?? "";
      // Prefer text/plain; fall back to a tag-stripped html render.
      const body = parsed.text ?? (parsed.html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const r = await ingestInboundEmail(env, {
        to,
        from: parsed.from?.address ?? "",
        subject: parsed.subject ?? "",
        body,
        messageId: parsed.messageId ?? null,
        inReplyTo: parsed.inReplyTo ?? null,
        references: parsed.references ?? null,
        attachments: (parsed.attachments ?? [])
          .filter((a) => a.disposition === "attachment" && a.filename)
          .map((a) => ({
            filename: a.filename ?? "attachment",
            mimeType: a.mimeType,
            content: typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content,
          })),
      });
      if (r.result === "rejected") message.setReject("no matching case");
    } catch (e) {
      await auditEvent(env.DB, { type: "inbound_error", severity: "error", data: { error: String(e) } });
      message.setReject("processing error");
    }
  },
};
