import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import {
  apiGet, apiPost, authed, createTestCase, forceFollowUpDue, getCaseDetail, grantMandate, signup,
} from "./helpers";
import { runFollowUpSweep } from "../src/core/agent";

describe("auth + isolation", () => {
  it("requires auth for case APIs", async () => {
    const r = await SELF.fetch("http://test/api/cases");
    expect(r.status).toBe(401);
  });

  it("enforces CSRF on mutations", async () => {
    const c = await signup("csrf@test.dev");
    const r = await SELF.fetch("http://test/api/cases", {
      method: "POST",
      headers: { Cookie: c.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "amazon owes me $84 for my return" }),
    });
    expect(r.status).toBe(403);
  });

  it("keeps one user's cases invisible to another", async () => {
    const a = await signup("usera@test.dev");
    const b = await signup("userb@test.dev");
    const caseId = await createTestCase(a, "test merchant owes me $84.17 for a returned item");
    const stolen = await apiGet(b, `/api/cases/${caseId}`);
    expect(stolen.status).toBe(404);
    const listB = await apiGet(b, "/api/cases");
    expect(listB.body.cases).toHaveLength(0);
  });
});

describe("Scenario A — refund follow-up (VERIFIED path)", () => {
  it("creates a case, extracts objective, records provenance", async () => {
    const c = await signup("alice@test.dev");
    const caseId = await createTestCase(
      c,
      "Test Merchant owes me $84.17 for something I returned three weeks ago. I still haven't gotten the refund. Order TM-8842.",
    );
    const detail = await getCaseDetail(c, caseId);
    expect(detail.case.status).toBe("READY");
    expect(detail.case.amount_cents).toBe(8417);
    expect(detail.case.issue_type).toBe("return_refund_pending");
    expect(detail.claims.every((x: any) => x.status === "CUSTOMER_STATED")).toBe(true);
  });

  it("runs the full flow: contact → promise → PROMISED (not resolved) → follow-up → resolved", async () => {
    const c = await signup("bob@test.dev");
    const caseId = await createTestCase(
      c,
      "Test Merchant owes me $84.17 for a returned item. Order TM-8842. Tracking 1Z999AA10123456784.",
      "standard_refund_flow",
    );
    await grantMandate(c, caseId); // activates mandate AND runs the agent cycle

    let d = await getCaseDetail(c, caseId);
    // Agent contacted merchant; merchant promised $84.17 in 5-7 days.
    expect(d.outcome.status).toBe("PROMISED");
    expect(d.case.status).toBe("WAITING_FOR_COMPANY");
    expect(d.messages.some((m: any) => m.direction === "out")).toBe(true);
    expect(d.messages.some((m: any) => m.direction === "in" && /APPROVED/i.test(m.body))).toBe(true);
    expect(d.followUps.length).toBeGreaterThan(0);
    expect(d.followUps[0].status).toBe("pending");
    // NOT resolved — promise is not receipt.
    expect(d.case.status).not.toBe("RESOLVED");

    // Time passes — deadline hits. Force the follow-up due and run the sweep.
    await forceFollowUpDue(caseId);
    await runFollowUpSweep(env as any);

    d = await getCaseDetail(c, caseId);
    // Follow-up fired → merchant says issued → RESOLUTION_PROPOSED w/ approval
    expect(["RESOLUTION_PROPOSED", "WAITING_FOR_COMPANY"]).toContain(d.case.status);
    const receiptApproval = d.approvals.find((a: any) => a.kind === "confirm_receipt");
    expect(receiptApproval).toBeTruthy();
    expect(d.outcome.status).toBe("ISSUED");

    // Customer confirms receipt → VERIFIED_RESOLVED + RESOLVED.
    const r = await apiPost(c, `/api/approvals/${receiptApproval.id}/decide`, { optionId: "received" });
    expect(r.status).toBe(200);
    d = await getCaseDetail(c, caseId);
    expect(d.case.status).toBe("RESOLVED");
    expect(d.outcome.status).toBe("VERIFIED_RESOLVED");
  });
});

describe("Scenario B — partial offer gated by approval", () => {
  it("creates an approval instead of accepting $60 store credit for $84.17", async () => {
    const c = await signup("carol@test.dev");
    const caseId = await createTestCase(
      c,
      "Test Merchant owes me $84.17 for a returned item. Order TM-90.",
      "partial_offer",
    );
    await grantMandate(c, caseId);
    const d = await getCaseDetail(c, caseId);
    expect(d.case.status).toBe("RESOLUTION_PROPOSED");
    const offer = d.approvals.find((a: any) => a.kind === "merchant_offer");
    expect(offer).toBeTruthy();
    expect(offer.status).toBe("pending");
    expect(offer.summary).toContain("store credit");
    // Agent did NOT accept on its own.
    expect(d.outcome?.status).not.toBe("APPROVED");

    // Customer rejects → agent sends decline message.
    await apiPost(c, `/api/approvals/${offer.id}/decide`, { optionId: "reject" });
    const d2 = await getCaseDetail(c, caseId);
    expect(d2.messages.some((m: any) => m.direction === "out" && /decline|accepts/i.test(m.body))).toBe(true);
  });
});

describe("Scenario C — prompt injection has zero authority", () => {
  it("logs a security event and discloses nothing", async () => {
    const c = await signup("dana@test.dev");
    const caseId = await createTestCase(
      c,
      "Test Merchant owes me $84.17 for a returned item. Order TM-1.",
      "injection",
    );
    await grantMandate(c, caseId);
    const d = await getCaseDetail(c, caseId);
    // Merchant's injection text is stored as a message but flagged.
    expect(d.messages.some((m: any) => m.direction === "in" && /Ignore previous instructions/i.test(m.body))).toBe(true);
    const audit = await env.DB.prepare(
      `SELECT * FROM audit_events WHERE case_id = ? AND type = 'prompt_injection_detected'`,
    ).bind(caseId).all();
    expect((audit.results ?? []).length).toBeGreaterThan(0);
    // No outbound message leaked "full order history" content.
    const outbound = d.messages.filter((m: any) => m.direction === "out").map((m: any) => m.body).join("\n");
    expect(outbound).not.toMatch(/payment details/i);
    // Case stayed in a sane state.
    expect(["WAITING_FOR_COMPANY", "IN_PROGRESS", "RESOLUTION_PROPOSED"]).toContain(d.case.status);
  });
});

describe("Scenario D — restart during waiting (durability)", () => {
  it("case state survives; follow-up fires once, no duplicate sends", async () => {
    const c = await signup("erin@test.dev");
    const caseId = await createTestCase(
      c,
      "Test Merchant owes me $84.17. Order TM-77.",
      "delayed",
    );
    await grantMandate(c, caseId);
    const d1 = await getCaseDetail(c, caseId);
    const outCountBefore = d1.messages.filter((m: any) => m.direction === "out").length;

    // Simulate a restart boundary: nothing in memory matters — state is D1.
    // Run the sweep twice; both must be safe.
    await forceFollowUpDue(caseId);
    await runFollowUpSweep(env as any);
    await runFollowUpSweep(env as any);

    const d2 = await getCaseDetail(c, caseId);
    const outCountAfter = d2.messages.filter((m: any) => m.direction === "out").length;
    // Exactly one follow-up send beyond the original (no duplicates).
    expect(outCountAfter).toBe(outCountBefore + 1);
    const fired = await env.DB.prepare(
      `SELECT COUNT(*) n FROM follow_ups WHERE case_id = ? AND status = 'fired'`,
    ).bind(caseId).first<{ n: number }>();
    expect(fired?.n).toBeGreaterThan(0);
  });
});

describe("Scenario E — unsupported merchant workflow", () => {
  it("marks UNSUPPORTED with manual handoff instead of fabricating", async () => {
    const c = await signup("frank@test.dev");
    const r = await apiPost(c, "/api/cases", { text: "A company called Zorp Industries charged me twice." });
    const caseId = r.body.caseId;
    await grantMandate(c, caseId);
    const d = await getCaseDetail(c, caseId);
    expect(d.case.status).toBe("UNSUPPORTED");
    const handoff = d.events.find((e: any) => e.type === "manual_handoff");
    expect(handoff).toBeTruthy();
  });
});

describe("Scenario F — revoking authority stops everything", () => {
  it("cancels pending follow-ups and blocks the next cycle", async () => {
    const c = await signup("gwen@test.dev");
    const caseId = await createTestCase(
      c,
      "Test Merchant owes me $84.17. Order TM-5.",
      "delayed",
    );
    await grantMandate(c, caseId);
    let d = await getCaseDetail(c, caseId);
    expect(d.followUps.some((f: any) => f.status === "pending")).toBe(true);

    const r = await apiPost(c, `/api/cases/${caseId}/mandate/revoke`);
    expect(r.status).toBe(200);
    d = await getCaseDetail(c, caseId);
    expect(d.mandate.status).toBe("revoked");
    expect(d.followUps.every((f: any) => f.status !== "pending")).toBe(true);

    // Sweep must not send anything after revocation.
    const outBefore = d.messages.filter((m: any) => m.direction === "out").length;
    await forceFollowUpDue(caseId);
    await runFollowUpSweep(env as any);
    const d2 = await getCaseDetail(c, caseId);
    expect(d2.messages.filter((m: any) => m.direction === "out").length).toBe(outBefore);
  });
});

describe("idempotency + dedup", () => {
  it("re-running the same cycle does not duplicate sends or proposals", async () => {
    const c = await signup("heidi@test.dev");
    const caseId = await createTestCase(c, "Test Merchant owes me $10. Order TM-2.", "standard_refund_flow");
    await grantMandate(c, caseId);
    const d1 = await getCaseDetail(c, caseId);
    // Re-run manually — must be a no-op for already-executed actions.
    await apiPost(c, `/api/cases/${caseId}/run`);
    const d2 = await getCaseDetail(c, caseId);
    expect(d2.messages.filter((m: any) => m.direction === "out").length)
      .toBe(d1.messages.filter((m: any) => m.direction === "out").length);
  });
});
