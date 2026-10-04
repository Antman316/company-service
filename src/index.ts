import {
  advanceCase,
  createCaseFromText,
  handleApprovalDecision,
  ingestMerchantMessage,
  runFollowUpSweep,
  suggestedMandate,
} from "./core/agent";
import { decideApproval, pendingApprovals } from "./core/approvals";
import { getCase, transitionCase } from "./core/caseEngine";
import { addEvidence, claimView, evidenceView, listClaims, listEvidence } from "./core/evidence";
import { json, nowIso, q, q1, run } from "./core/db";
import { caseEvent, auditEvent } from "./core/events";
import { cancelFollowUps } from "./core/followups";
import { activateMandate, createMandate, getLatestMandate, revokeMandate } from "./core/mandate";
import { latestOutcome } from "./core/outcomes";
import { seedRegistry } from "./adapters/registry";
import { resolveInboundCase, parseInbound } from "./email/threading";
import { encryptJson } from "./security/crypto";
import { getSession, requireCsrf, signin, signout, signup } from "./http/auth";

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
      await run(env.DB, `UPDATE cases SET meta = ? WHERE id = ?`, JSON.stringify({ scenario: b.scenario }), caseId);
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
      return new Response(obj.body, { headers: { "Content-Type": ev.mime ?? "application/octet-stream" } });
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
      await run(env.DB, `UPDATE cases SET paused = 1, updated_at = ? WHERE id = ?`, nowIso(), caseId);
      await cancelFollowUps(env.DB, caseId);
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
      await run(env.DB, `UPDATE connections SET status = 'revoked', updated_at = ? WHERE id = ?`, nowIso(), owned.id);
      await auditEvent(env.DB, { userId: uid, type: "connection_revoked", data: { connectionId: owned.id } });
      return res({ ok: true });
    }
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
    return res({ casesByStatus: cases, costsByCase: costs, totalMicroUsd: agg?.total ?? 0, casesWithCost: agg?.cases ?? 0 });
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
  };
}

async function ingestInboundText(env: Env, caseId: string, body: string) {
  const caseRow = await getCase(env.DB, caseId);
  if (!caseRow) return;
  const conv = await q1<{ id: string }>(
    env.DB,
    `SELECT id FROM external_conversations WHERE case_id = ? ORDER BY created_at DESC LIMIT 1`,
    caseId,
  );
  const convId = conv?.id ?? (await (async () => {
    const { ensureConversation } = await import("./core/agent");
    return ensureConversation(env.DB, caseId, "email", "inbound");
  })());
  await ingestMerchantMessage(env, caseRow, convId, body);
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
      // SPA assets (Assets binding handles not_found -> index.html).
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Company Service", { status: 200 });
    } catch (e) {
      console.error("unhandled", e);
      return err(500, "internal error");
    }
  },

  // Durable follow-up sweep — the "customer never has to remember" engine.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runFollowUpSweep(env).then((r) => console.log(`[sweep] fired=${r.fired}`)));
  },

  // Inbound email via Cloudflare Email Routing.
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const raw = await new Response(message.raw).text();
      const parsed = parseInbound(raw);
      const caseId = await resolveInboundCase(env.DB, {
        to: message.to || parsed.to,
        subject: parsed.subject,
        headers: parsed.headers,
      });
      if (!caseId) {
        await auditEvent(env.DB, { type: "inbound_unmatched", severity: "warning", data: { to: message.to } });
        message.setReject("no matching case");
        return;
      }
      await ingestInboundText(env, caseId, parsed.body || "(no body)");
    } catch (e) {
      await auditEvent(env.DB, { type: "inbound_error", severity: "error", data: { error: String(e) } });
      message.setReject("processing error");
    }
  },
};
