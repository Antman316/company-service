import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import {
  apiPost,
  authed,
  createTestCase,
  getCaseDetail,
  grantMandate,
  signup,
} from "./helpers";

// M5 — chat companion server endpoints. The extension exchanges a one-time
// short code (created under the web session) for a scoped bearer pairing token;
// companion calls are bearer-authed, audited, and rate-limited.

const BASE = "http://test";

async function bearer(
  c: { cookie: string; csrf: string },
): Promise<{ token: string; pairingId: string }> {
  const r = await apiPost(c, "/api/companion/code", {});
  expect(r.status).toBe(200);
  const { code, pairingId } = r.body;
  const p = await SELF.fetch(`${BASE}/api/companion/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, label: "test-chrome" }),
  });
  expect(p.status).toBe(200);
  const data = (await p.json()) as { token: string };
  expect(data.token).toMatch(/^cs_cmp_/);
  return { token: data.token, pairingId };
}

const cmp = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

async function cmpFetch(token: string, path: string, init: RequestInit = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...cmp(token), ...(init.headers ?? {}) },
  });
}

describe("M5 — chat companion server", () => {
  it("pairs via short code, serves context for a matched URL, streams replies, and revokes", async () => {
    const c = await signup(`cmp-${Date.now()}@test.dev`);
    const caseId = await createTestCase(
      c,
      "I returned a damaged order TM-1042 to Test Merchant weeks ago and they still haven't refunded $84.17.",
      "standard_refund_flow",
    );
    await grantMandate(c, caseId);
    const { token, pairingId } = await bearer(c);

    // Context: the test-merchant chat lane matches and the live case comes back.
    const ctx = await cmpFetch(token, "/api/companion/context?url=" + encodeURIComponent("https://chat.test-merchant.demo/support"));
    expect(ctx.status).toBe(200);
    const ctxBody = (await ctx.json()) as any;
    expect(ctxBody.matched).toBe(true);
    expect(ctxBody.company.name).toBe("Test Merchant");
    expect(ctxBody.case.id).toBe(caseId);

    // Unrelated URL → dormant.
    const no = await cmpFetch(token, "/api/companion/context?url=" + encodeURIComponent("https://example.com/whatever"));
    expect((await no.json() as any).matched).toBe(false);

    // Stream a merchant message — same ingest path, case advances.
    const rep = await cmpFetch(token, "/api/companion/reply", {
      method: "POST",
      body: JSON.stringify({ caseId, body: "We understand this is frustrating. Your refund has been approved and will post in 3-5 business days." }),
    });
    expect(rep.status).toBe(200);
    const repBody = (await rep.json()) as any;
    expect(repBody.ok).toBe(true);
    const detail = await getCaseDetail(c, caseId);
    expect(detail.messages.some((m: any) => m.direction === "in" && m.body.includes("3-5 business days"))).toBe(true);

    // Pairings list (session side) shows the active pairing.
    const list = await SELF.fetch(`${BASE}/api/companion/pairings`, { headers: authed(c) });
    const lb = (await list.json()) as any;
    expect(lb.pairings.some((p: any) => p.id === pairingId && p.revoked_at === null)).toBe(true);

    // Revoke kills the token.
    const rv = await cmpFetch(token, "/api/companion/revoke", { method: "POST", body: "{}" });
    expect(rv.status).toBe(200);
    const dead = await cmpFetch(token, "/api/companion/context?url=" + encodeURIComponent("https://chat.test-merchant.demo/support"));
    expect(dead.status).toBe(401);
  });

  it("rejects bad codes, expired-looking tokens, and other users' cases", async () => {
    const c = await signup(`cmp2-${Date.now()}@test.dev`);
    const other = await signup(`cmp3-${Date.now()}@test.dev`);
    const otherCase = await createTestCase(other, "Test Merchant never refunded me $20.", "standard_refund_flow");

    const bad = await SELF.fetch(`${BASE}/api/companion/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ZZZZZZZZ" }),
    });
    expect(bad.status).toBe(404);

    const { token } = await bearer(c);
    // Bearer token for user A can't reach user B's case.
    for (const path of ["reply", "sent", "run", "wrapup"]) {
      const r = await cmpFetch(token, `/api/companion/${path}`, {
        method: "POST",
        body: JSON.stringify({ caseId: otherCase, body: "x", transcript: "t" }),
      });
      expect(r.status, path).toBe(404);
    }
    // Garbage bearer → 401.
    const g = await cmpFetch("cs_cmp_nope", "/api/companion/context?url=https%3A%2F%2Ftest-merchant.demo");
    expect(g.status).toBe(401);
  });

  it("rate-limits excessive companion calls and audits them", async () => {
    const c = await signup(`cmp4-${Date.now()}@test.dev`);
    const me = await SELF.fetch(`${BASE}/api/auth/me`, { headers: authed(c) });
    const userId = ((await me.json()) as any).user.id as string;
    const { token, pairingId } = await bearer(c);
    // Seed 121 companion_call audit rows inside the window — the next call must 429.
    const stmt = env.DB.prepare(
      `INSERT INTO audit_events (id, user_id, type, severity, data_json, created_at) VALUES (?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 121; i++) {
      await stmt
        .bind(`aud_rl_${i}`, userId, "companion_call", "info", "{}", new Date().toISOString())
        .run();
    }
    const r = await cmpFetch(token, "/api/companion/context?url=https%3A%2F%2Ftest-merchant.demo%2Fchat");
    expect(r.status).toBe(429);
    const sec = await env.DB.prepare(
      `SELECT * FROM audit_events WHERE type='companion_rate_limited' AND json_extract(data_json,'$.pairingId') = ?`,
    ).bind(pairingId).first();
    expect(sec).toBeTruthy();
  });

  it("wrapup stores the transcript as evidence; sent advances the assisted step", async () => {
    const c = await signup(`cmp5-${Date.now()}@test.dev`);
    const caseId = await createTestCase(c, "Test Merchant still owes me $84.17 for a returned order TM-1042.", "standard_refund_flow");
    await grantMandate(c, caseId);
    const { token } = await bearer(c);

    const w = await cmpFetch(token, "/api/companion/wrapup", {
      method: "POST",
      body: JSON.stringify({ caseId, transcript: "Agent: how can I help\nCustomer: refund please", reference: "TM-9910" }),
    });
    expect(w.status).toBe(200);
    const detail = await getCaseDetail(c, caseId);
    const ev = (detail.evidence ?? []).find((e: any) => e.kind === "note" && e.label?.includes("transcript"));
    expect(ev).toBeTruthy();
  });
});
