// Chat-companion (browser extension) API. Two auth styles:
//   - session + CSRF (web app): create pairing codes, list/revoke pairings
//   - Bearer token (extension): context, reply streaming, sent, run, wrapup
// Bearer calls are CSRF-exempt by design — the pairing token IS the credential,
// no cookie is sent. Every call is rate-limited per pairing and audit-logged.

import { newId, nowIso, q, q1, run, sha256Hex, addMs, json } from "../core/db";
import { caseEvent, auditEvent } from "../core/events";
import { getCase } from "../core/caseEngine";
import { addEvidence } from "../core/evidence";
import { advanceCase, ensureConversation, ingestMerchantMessage } from "../core/agent";
import { transitionCase } from "../core/caseEngine";
import { scheduleFollowUp } from "../core/followups";
import { requireCsrf } from "./auth";

type Session = { userId: string; csrf: string; token: string } | null;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Max-Age": "600",
};

function res(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(JSON.stringify(body), { ...init, headers });
}
const err = (status: number, error: string) => res({ error }, { status });

interface Pairing {
  id: string;
  user_id: string;
  label: string | null;
  created_at: string;
}

async function bearerAuth(req: Request, db: D1Database): Promise<Pairing | null> {
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(cs_cmp_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const row = await q1<Pairing>(
    db,
    `SELECT id, user_id, label, created_at FROM companion_pairings WHERE token_hash = ? AND revoked_at IS NULL`,
    await sha256Hex(m[1]!),
  );
  return row ?? null;
}

// Per-pairing rate limit counted from the audit trail itself (every companion
// call is logged first): 120 calls/minute and 4000/day. Excess is a 429 and
// itself audited at security severity — never silent.
async function rateLimited(db: D1Database, pairing: Pairing): Promise<boolean> {
  const minute = await q1<{ n: number }>(
    db,
    `SELECT COUNT(*) n FROM audit_events WHERE user_id = ? AND type = 'companion_call'
     AND created_at > ?`,
    pairing.user_id,
    new Date(Date.now() - 60_000).toISOString(),
  );
  const day = await q1<{ n: number }>(
    db,
    `SELECT COUNT(*) n FROM audit_events WHERE user_id = ? AND type = 'companion_call'
     AND created_at > ?`,
    pairing.user_id,
    new Date(Date.now() - 24 * 3600_000).toISOString(),
  );
  const over = (minute?.n ?? 0) > 120 || (day?.n ?? 0) > 4000;
  if (over) {
    await auditEvent(db, {
      userId: pairing.user_id,
      type: "companion_rate_limited",
      severity: "security",
      data: { pairingId: pairing.id },
    });
  }
  return over;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion
function makeCode(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}
function makeToken(): string {
  return `cs_cmp_${newId("tk").replace(/^tk_/, "")}${newId("tk").replace(/^tk_/, "")}`;
}

const TERMINAL: string[] = ["RESOLVED", "UNRESOLVED", "UNSUPPORTED", "CANCELLED"];

// Find the company whose registered domains match the page URL's hostname.
async function companyForUrl(db: D1Database, rawUrl: string) {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  const companies = await q<{ id: string; name: string; domains: string | null }>(db, `SELECT id, name, domains FROM companies`);
  return (
    companies.find((c) => {
      const domains = json<string[]>(c.domains, []);
      return domains.some((d) => host === d || host.endsWith(`.${d}`));
    }) ?? null
  );
}

async function latestDraft(db: D1Database, caseId: string) {
  return q1<{ id: string; body: string; created_at: string }>(
    db,
    `SELECT m.id, m.body, m.created_at FROM external_messages m
     JOIN external_conversations c ON c.id = m.conversation_id
     WHERE c.case_id = ? AND m.direction = 'out' AND m.status = 'drafted'
     ORDER BY m.created_at DESC LIMIT 1`,
    caseId,
  );
}

export async function handleCompanion(
  req: Request,
  env: Env,
  url: URL,
  session: Session,
): Promise<Response | null> {
  const db = env.DB;
  const path = url.pathname;
  if (!path.startsWith("/api/companion")) return null;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // ---- session-authed management endpoints ----

  // Create a pairing code (shown once; the extension trades it for a token).
  if (path === "/api/companion/code" && req.method === "POST") {
    if (!session) return err(401, "not signed in");
    if (!requireCsrf(req, session)) return err(403, "csrf token missing or invalid");
    const code = makeCode();
    const id = newId("cmp");
    await run(
      db,
      `INSERT INTO companion_pairings (id, user_id, token_hash, label) VALUES (?,?,?,'pending')`,
      id,
      session.userId,
      await sha256Hex(`code:${code}`),
    );
    await auditEvent(db, { userId: session.userId, type: "companion_code_created", data: { pairingId: id } });
    return res({ code, pairingId: id, expiresInSeconds: 900 });
  }

  // List the caller's pairings (Connections page).
  if (path === "/api/companion/pairings" && req.method === "GET") {
    if (!session) return err(401, "not signed in");
    const rows = await q<Record<string, unknown>>(
      db,
      `SELECT id, label, created_at, revoked_at FROM companion_pairings WHERE user_id = ? ORDER BY created_at DESC`,
      session.userId,
    );
    return res({ pairings: rows });
  }

  // ---- unauthenticated token exchange (the short code IS the credential) ----
  if (path === "/api/companion/pair" && req.method === "POST") {
    const b = (await req.json()) as { code?: string; label?: string };
    const code = (b.code ?? "").trim().toUpperCase();
    if (code.length < 6) return err(400, "invalid code");
    // Crude global throttle on failed exchanges (D1 counter, audited).
    const fails = await q1<{ n: number }>(
      db,
      `SELECT COUNT(*) n FROM audit_events WHERE type = 'companion_pair_failed' AND created_at > ?`,
      new Date(Date.now() - 10 * 60_000).toISOString(),
    );
    if ((fails?.n ?? 0) > 30) return err(429, "too many attempts — slow down");
    const pending = await q1<Pairing & { created_at: string }>(
      db,
      `SELECT id, user_id, label, created_at FROM companion_pairings WHERE token_hash = ? AND label = 'pending' AND revoked_at IS NULL`,
      await sha256Hex(`code:${code}`),
    );
    const expired = pending && new Date(pending.created_at).getTime() < Date.now() - 15 * 60_000;
    if (!pending || expired) {
      await auditEvent(db, { type: "companion_pair_failed", severity: "warning" });
      return err(404, "code not found or expired");
    }
    const token = makeToken();
    await run(
      db,
      `UPDATE companion_pairings SET token_hash = ?, label = ? WHERE id = ?`,
      await sha256Hex(token),
      b.label?.slice(0, 60) ?? "chrome",
      pending.id,
    );
    await auditEvent(db, { userId: pending.user_id, type: "companion_paired", data: { pairingId: pending.id } });
    return res({ token, pairingId: pending.id });
  }

  // ---- everything below needs a bearer pairing token ----
  const pairing = await bearerAuth(req, db);
  if (!pairing) {
    // A session user can also revoke a pairing they own.
    if (path === "/api/companion/revoke" && req.method === "POST" && session) {
      if (!requireCsrf(req, session)) return err(403, "csrf token missing or invalid");
      const b = (await req.json()) as { pairingId?: string };
      const owned = await q1<{ id: string }>(
        db,
        `SELECT id FROM companion_pairings WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
        b.pairingId ?? "",
        session.userId,
      );
      if (!owned) return err(404, "pairing not found");
      await run(db, `UPDATE companion_pairings SET revoked_at = ? WHERE id = ?`, nowIso(), owned.id);
      await auditEvent(db, { userId: session.userId, type: "companion_revoked", data: { pairingId: owned.id } });
      return res({ ok: true });
    }
    return err(401, "invalid or revoked pairing token");
  }
  const uid = pairing.user_id;

  await auditEvent(db, { userId: uid, type: "companion_call", data: { route: path, pairingId: pairing.id } });
  if (await rateLimited(db, pairing)) return err(429, "rate limit exceeded");

  // Allowlist the extension prefilters with — keeps us out of every other tab.
  if (path === "/api/companion/domains" && req.method === "GET") {
    const companies = await q<{ domains: string | null }>(db, `SELECT domains FROM companies`);
    const domains = companies.flatMap((c) => json<string[]>(c.domains, []));
    return res({ domains });
  }

  // Self-revocation from the extension.
  if (path === "/api/companion/revoke" && req.method === "POST") {
    await run(db, `UPDATE companion_pairings SET revoked_at = ? WHERE id = ?`, nowIso(), pairing.id);
    await auditEvent(db, { userId: uid, type: "companion_revoked", data: { pairingId: pairing.id } });
    return res({ ok: true });
  }

  // Match a page URL to a company + the user's live case and current draft.
  if (path === "/api/companion/context" && req.method === "GET") {
    const pageUrl = url.searchParams.get("url") ?? "";
    const company = await companyForUrl(db, pageUrl);
    if (!company) return res({ matched: false });
    const lanes = await q<{ channel: string; channel_address: string | null; automation_level: string; verification_status: string }>(
      db,
      `SELECT channel, channel_address, automation_level, verification_status FROM company_coverage
       WHERE company_id = ? AND channel IN ('chat','form')`,
      company.id,
    );
    const lane = lanes.find((l) => l.channel === "chat") ?? lanes[0] ?? null;
    const cases = await q<Record<string, unknown>>(
      db,
      `SELECT id, title, status, status_reason, updated_at FROM cases
       WHERE user_id = ? AND company_id = ? ORDER BY updated_at DESC`,
      uid,
      company.id,
    );
    const active = cases.find((c) => !TERMINAL.includes(String(c.status)));
    let draft = null;
    let transcript: unknown[] = [];
    let rung: number | null = null;
    if (active) {
      draft = (await latestDraft(db, active.id as string)) ?? null;
      transcript = await q(
        db,
        `SELECT m.direction, m.body, m.status, m.created_at FROM external_messages m
         JOIN external_conversations c ON c.id = m.conversation_id
         WHERE c.case_id = ? ORDER BY m.created_at DESC LIMIT 8`,
        active.id,
      );
      const esc = await q1<{ rung: number }>(
        db,
        `SELECT MAX(rung) rung FROM case_escalations WHERE case_id = ? AND status IN ('executed','awaiting_approval')`,
        active.id,
      );
      rung = esc?.rung ?? null;
    }
    return res({
      matched: true,
      company: { id: company.id, name: company.name },
      lane: lane ? { channel: lane.channel, address: lane.channel_address, level: lane.automation_level, verification: lane.verification_status } : null,
      case: active
        ? { id: active.id, title: active.title, status: active.status, statusReason: active.status_reason, rung }
        : null,
      draft: draft ? { id: draft.id, body: draft.body } : null,
      transcriptTail: transcript.reverse(),
    });
  }

  // Everything below takes a caseId the pairing user must own.
  const ownedCase = async (caseId: string | undefined) => {
    if (!caseId) return null;
    return q1<{ id: string; status: string }>(
      db,
      `SELECT id, status FROM cases WHERE id = ? AND user_id = ?`,
      caseId,
      uid,
    );
  };

  // Streamed merchant chat text → same UNTRUSTED ingest as pasted replies.
  if (path === "/api/companion/reply" && req.method === "POST") {
    const b = (await req.json()) as { caseId?: string; body?: string };
    const owned = await ownedCase(b.caseId);
    if (!owned) return err(404, "case not found");
    if (!b.body?.trim()) return err(400, "empty reply");
    const caseRow = await getCase(db, owned.id);
    if (!caseRow) return err(404, "case not found");
    const convId = await ensureConversation(db, owned.id, "chat", "companion");
    await ingestMerchantMessage(env, caseRow, convId, b.body.trim().slice(0, 50_000), {
      meta: { transport: "companion", pairingId: pairing.id },
    });
    const outcome = await advanceCase(env, owned.id, "companion_reply");
    const draft = await latestDraft(db, owned.id);
    return res({ ok: true, case: outcome, draft: draft ? { id: draft.id, body: draft.body } : null });
  }

  // "I sent it" — same semantic as the assisted/sent web flow.
  if (path === "/api/companion/sent" && req.method === "POST") {
    const b = (await req.json()) as { caseId?: string };
    const owned = await ownedCase(b.caseId);
    if (!owned) return err(404, "case not found");
    const act = await q1<{ id: string }>(
      db,
      `SELECT id FROM case_actions WHERE case_id = ? AND status = 'awaiting_customer' ORDER BY created_at DESC LIMIT 1`,
      owned.id,
    );
    if (!act) return err(409, "no assisted step is waiting on you");
    await run(db, `UPDATE case_actions SET status='executed', executed_at=? WHERE id=?`, nowIso(), act.id);
    await caseEvent(db, owned.id, "assisted_sent", "customer", { actionId: act.id, via: "companion" });
    await transitionCase(db, owned.id, "WAITING_FOR_COMPANY", { reason: "customer sent companion message", actor: "customer" });
    await scheduleFollowUp(db, owned.id, "send_followup", addMs(nowIso(), 2 * 24 * 3600 * 1000), { via: "companion" });
    return res({ ok: true });
  }

  // Regenerate — advance the case one step (draft refresh, follow-up, etc.).
  if (path === "/api/companion/run" && req.method === "POST") {
    const b = (await req.json()) as { caseId?: string };
    const owned = await ownedCase(b.caseId);
    if (!owned) return err(404, "case not found");
    const outcome = await advanceCase(env, owned.id, "companion_run");
    const draft = await latestDraft(db, owned.id);
    return res({ ok: true, case: outcome, draft: draft ? { id: draft.id, body: draft.body } : null });
  }

  // End-of-chat wrap-up: full transcript lands as case evidence.
  if (path === "/api/companion/wrapup" && req.method === "POST") {
    const b = (await req.json()) as { caseId?: string; transcript?: string; reference?: string };
    const owned = await ownedCase(b.caseId);
    if (!owned) return err(404, "case not found");
    if (!b.transcript?.trim()) return err(400, "empty transcript");
    const evidenceId = await addEvidence(db, env, owned.id, {
      kind: "note",
      text: `CHAT TRANSCRIPT (captured by companion extension)\n${b.reference ? `Merchant reference: ${b.reference}\n` : ""}${"=".repeat(60)}\n${b.transcript.trim()}`,
      source: "companion",
      label: "Chat transcript (companion capture)",
    });
    await caseEvent(db, owned.id, "companion_transcript_saved", "customer", { evidenceId, pairingId: pairing.id });
    return res({ ok: true, evidenceId });
  }

  return err(404, "not found");
}
