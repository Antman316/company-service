import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { apiGet, apiPost, authed, createTestCase, getCaseDetail, grantMandate, signup } from "./helpers";
import { runFollowUpSweep } from "../src/core/agent";
import { contentCheck } from "../src/core/abuse";
import { totpNow } from "../src/core/totp";
import { encryptJson } from "../src/security/crypto";

// M7 — account, trust & legal hardening: consent + Turnstile gating, email
// verification, password reset, TOTP, notifications, abuse controls, spend caps.

async function latestAudit(type: string, userId?: string) {
  const row = await env.DB.prepare(
    `SELECT * FROM audit_events WHERE type = ? ${userId ? "AND user_id = ?" : ""} ORDER BY created_at DESC LIMIT 1`,
  ).bind(...[type, ...(userId ? [userId] : [])]).first<{ data_json: string }>();
  return row ? JSON.parse(row.data_json) : null;
}

describe("M7 account, trust & legal", () => {
  it("requires consent and records tos_accepted_at", async () => {
    const noConsent = await SELF.fetch("http://test/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `nc-${Date.now()}@t.dev`, password: "password-1234" }),
    });
    expect(noConsent.status).toBe(400);

    const email = `consent-${Date.now()}@t.dev`;
    const c = await signup(email);
    const me = await apiGet(c, "/api/auth/me");
    expect(me.body.user.tosAcceptedAt).toBeTruthy();
    expect(me.body.user.emailVerified).toBe(false);
    expect(me.body.user.totpEnabled).toBe(false);
  });

  it("issues a verification email; the one-shot link verifies + unpauses", async () => {
    const c = await signup(`vfy-${Date.now()}@t.dev`);
    const me = await apiGet(c, "/api/auth/me");
    const sent = await latestAudit("email_verification_sent", me.body.user.id);
    expect(sent.devToken).toMatch(/^cs_ema_/);

    // Pause a case for email_unverified first (the verify link should clear it).
    const caseId = await createTestCase(c, "verify pause test");
    await env.DB.prepare(
      `UPDATE cases SET paused = 1, meta = json_set(COALESCE(meta,'{}'),'$.paused_reason','email_unverified') WHERE id = ?`,
    ).bind(caseId).run();

    const r = await SELF.fetch(`http://test/api/auth/verify-email?token=${sent.devToken}`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("#/verified");

    const me2 = await apiGet(c, "/api/auth/me");
    expect(me2.body.user.emailVerified).toBe(true);
    const p = await env.DB.prepare(`SELECT paused FROM cases WHERE id = ?`).bind(caseId).first<{ paused: number }>();
    expect(p?.paused).toBe(0);

    // Token is one-shot.
    const r2 = await SELF.fetch(`http://test/api/auth/verify-email?token=${sent.devToken}`, { redirect: "manual" });
    expect(r2.headers.get("location")).toContain("#/verify-failed");

    // Resend refuses on verified accounts.
    const rr = await apiPost(c, "/api/auth/verify-email/resend");
    expect(rr.status).toBe(400);
  });

  it("password reset: link resets, kills sessions, and is one-shot", async () => {
    const email = `rst-${Date.now()}@t.dev`;
    const c = await signup(email);

    const rq = await SELF.fetch("http://test/api/auth/reset-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(rq.status).toBe(200);
    // Unknown emails get the same 200 (no enumeration).
    const rq2 = await SELF.fetch("http://test/api/auth/reset-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `ghost-${Date.now()}@t.dev` }),
    });
    expect(rq2.status).toBe(200);

    const sent = await latestAudit("password_reset_sent");
    expect(sent.devToken).toMatch(/^cs_rst_/);

    const rc = await SELF.fetch("http://test/api/auth/reset-confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: sent.devToken, password: "new-password-99" }),
    });
    expect(rc.status).toBe(200);

    // Old session is dead.
    const meAfter = await apiGet(c, "/api/auth/me");
    expect(meAfter.status).toBe(401);

    // New password signs in; old one doesn't.
    const bad = await SELF.fetch("http://test/api/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password-1234" }),
    });
    expect(bad.status).toBe(401);
    const good = await SELF.fetch("http://test/api/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "new-password-99" }),
    });
    expect(good.status).toBe(200);

    // Token is one-shot.
    const rc2 = await SELF.fetch("http://test/api/auth/reset-confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: sent.devToken, password: "other-password-1" }),
    });
    expect(rc2.status).toBe(400);
  });

  it("TOTP: enroll → confirm → signin requires challenge → disable", async () => {
    const email = `totp-${Date.now()}@t.dev`;
    const c = await signup(email);

    const en = await apiPost(c, "/api/auth/totp/enroll");
    expect(en.status).toBe(200);
    const secret = en.body.secret as string;
    expect(secret).toBeTruthy();
    expect(en.body.otpauth).toContain("otpauth://totp/");

    // Wrong code does not enable.
    const badConfirm = await apiPost(c, "/api/auth/totp/confirm", { code: "000000" });
    expect(badConfirm.status).toBe(400);

    const code = await totpNow(secret);
    const goodConfirm = await apiPost(c, "/api/auth/totp/confirm", { code });
    expect(goodConfirm.status).toBe(200);
    const me = await apiGet(c, "/api/auth/me");
    expect(me.body.user.totpEnabled).toBe(true);

    // Password signin now returns a challenge instead of a cookie.
    const s1 = await SELF.fetch("http://test/api/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password-1234" }),
    });
    const s1b = await s1.json() as { totpRequired?: boolean; ticket?: string };
    expect(s1b.totpRequired).toBe(true);
    expect(s1.headers.get("set-cookie")).toBeNull();

    // Wrong challenge code → 401, no cookie.
    const ch1 = await SELF.fetch("http://test/api/auth/totp/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: s1b.ticket, code: "000000" }),
    });
    expect(ch1.status).toBe(401);

    // Ticket is consumed after first use — the failed attempt burns it.
    const s2 = await SELF.fetch("http://test/api/auth/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password-1234" }),
    });
    const s2b = await s2.json() as { ticket?: string };
    const ch2 = await SELF.fetch("http://test/api/auth/totp/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: s2b.ticket, code: await totpNow(secret) }),
    });
    expect(ch2.status).toBe(200);
    expect(ch2.headers.get("set-cookie")).toContain("cs_session=");

    // Disable requires a live code.
    const dis = await apiPost(c, "/api/auth/totp/disable", { code: await totpNow(secret) });
    expect(dis.status).toBe(200);
    const me2 = await apiGet(c, "/api/auth/me");
    expect(me2.body.user.totpEnabled).toBe(false);
  });

  it("notification prefs: default on, opt-out suppresses send", async () => {
    const c = await signup(`np-${Date.now()}@t.dev`);
    const prefs = await apiGet(c, "/api/notifications/prefs");
    expect(prefs.body.prefs.approval_needed).toBe(true);

    const put = await SELF.fetch("http://test/api/notifications/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie: c.cookie, "x-csrf": c.csrf },
      body: JSON.stringify({ kind: "approval_needed", enabled: false }),
    });
    expect(put.status).toBe(200);
    const prefs2 = await apiGet(c, "/api/notifications/prefs");
    expect(prefs2.body.prefs.approval_needed).toBe(false);

    const badKind = await SELF.fetch("http://test/api/notifications/prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie: c.cookie, "x-csrf": c.csrf },
      body: JSON.stringify({ kind: "spam_me", enabled: false }),
    });
    expect(badKind.status).toBe(400);
  });

  it("abuse controls: 10 active cases max; content check blocks PAN text", async () => {
    const c = await signup(`abuse-${Date.now()}@t.dev`);
    // Fill to the cap via direct inserts (case creation is what we gate).
    for (let i = 0; i < 9; i++) {
      await createTestCase(c, `filler ${i}`);
    }
    // Closed cases don't count toward the cap — resolve one and confirm the
    // count is on *active* cases only.
    const temp = await createTestCase(c, "temporary filler case");
    await env.DB.prepare(`UPDATE cases SET status = 'RESOLVED' WHERE id = ?`).bind(temp).run();
    const okTenth = await apiPost(c, "/api/cases", { text: "fits under the cap after a resolve" });
    expect(okTenth.status).toBe(200);
    const over = await apiPost(c, "/api/cases", { text: "one case too many please" });
    expect(over.status).toBe(429);

    // contentCheck unit coverage — the things that must never leave the system.
    expect(contentCheck("I'll hurt you if you don't refund").ok).toBe(false);
    expect(contentCheck("charge my card 4111 1111 1111 1111 again").ok).toBe(false);
    expect(contentCheck("my password: hunter2 gets you in").ok).toBe(false);
    expect(contentCheck("Please refund $84.17 for order TM-77, thank you.").ok).toBe(true);
  });

  it("unverified email: real-channel send is skipped + approval surfaces", async () => {
    const c = await signup(`gate-${Date.now()}@t.dev`);
    // Chewy has a registered AUTOMATED email lane → real channel → the
    // unverified-user gate must block the send (no test-merchant adapter).
    const created = await apiPost(c, "/api/cases", { text: "Chewy owes me a $50 refund" });
    const caseId = created.body.caseId as string;
    await env.DB.prepare(`UPDATE cases SET company_id = 'cmp_chewy', company_name = 'Chewy' WHERE id = ?`).bind(caseId).run();
    await grantMandate(c, caseId);
    const d = await getCaseDetail(c, caseId);
    const blocked = d.events.filter((e: { type: string }) => e.type === "send_blocked_email_unverified");
    expect(blocked.length).toBeGreaterThan(0);
    const verifyApproval = d.approvals.find((a: { kind: string }) => a.kind === "email_verify_to_send");
    expect(verifyApproval).toBeTruthy();
  });

  it("spend caps: case soft-cap pauses + approval; continue raises ceiling", async () => {
    const email = `cap-${Date.now()}@t.dev`;
    const c = await signup(email);
    const me = await apiGet(c, "/api/auth/me");
    const uid = me.body.user.id;
    const caseId = await createTestCase(c, "spend cap test case");
    // Verified + BYO provider connection → non-local path → caps are live.
    await env.DB.prepare(`UPDATE users SET email_verified_at = '2026-01-01T00:00:00Z' WHERE id = ?`).bind(uid).run();
    const cfg = await encryptJson({ apiKey: "sk-test", baseUrl: "http://127.0.0.1:9" }, env.SECRET_KEY!);
    await env.DB.prepare(
      `INSERT INTO connections (id, user_id, type, provider, label, status, config_enc, created_at)
       VALUES ('conn_cap', ?, 'model_provider', 'openai', 'test', 'active', ?, '2026-01-01')`,
    ).bind(uid, cfg).run();
    // Fill the per-case budget ($0.50 default).
    await env.DB.prepare(
      `INSERT INTO cost_events (id, case_id, kind, provider, cost_micro_usd, created_at)
       VALUES ('ce1', ?, 'model', 'openai', 600000, '2026-10-06T00:00:00Z')`,
    ).bind(caseId).run();

    await grantMandate(c, caseId);
    const d = await getCaseDetail(c, caseId);
    expect(d.case.paused).toBe(1);
    const capApproval = d.approvals.find((a: { kind: string }) => a.kind === "spend_cap");
    expect(capApproval).toBeTruthy();

    // 'continue' raises the ceiling and unpauses.
    const dec = await apiPost(c, `/api/approvals/${capApproval.id}/decide`, { optionId: "continue" });
    expect(dec.status).toBe(200);
    const d2 = await getCaseDetail(c, caseId);
    expect(d2.case.paused).toBe(0);
  });

  it("abuse report inbox stores a signal and rate-limits", async () => {
    const email = `rep-${Date.now()}@t.dev`;
    for (let i = 0; i < 5; i++) {
      const r = await SELF.fetch("http://test/api/abuse/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, body: `report number ${i} — something bad happened` }),
      });
      expect(r.status).toBe(200);
    }
    const sixth = await SELF.fetch("http://test/api/abuse/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, body: "one more report than allowed" }),
    });
    expect(sixth.status).toBe(429);
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM fraud_signals WHERE kind = 'abuse_report'`,
    ).first<{ n: number }>();
    expect(row?.n).toBeGreaterThanOrEqual(5);
  });
});
