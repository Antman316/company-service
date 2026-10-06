import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { runFollowUpSweep } from "../src/core/agent";
import { buildPdf, wrapText } from "../src/core/pdf";
import { detectDeflection } from "../src/core/escalation";
import {
  apiPost,
  authed,
  createTestCase,
  forceDeadlineDue,
  getCaseDetail,
  grantMandate,
  signup,
} from "./helpers";

// M3 acceptance: a stonewalling merchant drives a case up rungs 1→5; rung 5
// stops at an approval card with the rendered card-dispute draft; approving it
// materializes the letter + evidence-bundle PDF. Plus: deflection detection
// units, honest deadline labels, and the sweep driving missed promises.

const INTAKE =
  "I returned a damaged order TM-1042 to Test Merchant weeks ago and they still haven't refunded $84.17.";

async function runUntil(c: { cookie: string; csrf: string }, caseId: string, pred: (d: any) => boolean, max = 10) {
  let detail = await getCaseDetail(c, caseId);
  for (let i = 0; i < max && !pred(detail); i++) {
    await apiPost(c, `/api/cases/${caseId}/run`);
    detail = await getCaseDetail(c, caseId);
  }
  return detail;
}

describe("M3 — escalation ladder (Test Merchant stonewall)", () => {
  it("climbs rungs 1→5, stops at a draft approval, and materializes docs on approve", async () => {
    const c = await signup(`esc-st-${Date.now()}@test.dev`);
    const caseId = await createTestCase(c, INTAKE, "stonewall");
    // Customer-entered facts the letter uses (card type + statement date).
    const fr = await apiPost(c, `/api/cases/${caseId}/facts`, {
      cardType: "credit",
      statementDate: "2026-09-01",
    });
    expect(fr.status).toBe(200);
    await grantMandate(c, caseId);

    const detail = await runUntil(c, caseId, (d) =>
      (d.approvals ?? []).some((a: any) => a.status === "pending" && a.detail?.payload?.draft),
    );
    const approval = (detail.approvals ?? []).find(
      (a: any) => a.status === "pending" && a.detail?.payload?.draft,
    );
    expect(approval, "rung-5 approval card with the rendered draft").toBeTruthy();

    // The ladder was climbed in order, tracked in case_escalations.
    const rungs = (detail.escalations ?? []).map((e: any) => e.rung);
    expect(rungs).toEqual([1, 2, 3, 4, 5]);
    expect(detail.escalations.find((e: any) => e.rung === 4)?.status).toBe("executed");
    expect(detail.escalations.find((e: any) => e.rung === 5)?.status).toBe("awaiting_approval");

    // Deadlines are source-labeled honestly.
    const dl = (detail.deadlines ?? []).map((d: any) => `${d.kind}:${d.source}`);
    expect(dl).toContain("supervisor_response:COMPUTED");
    expect(dl).toContain("chargeback_window:CUSTOMER_STATED");

    // The draft itself — facts in, merchant text out.
    const draft: string = approval.detail.payload.draft;
    expect(draft).toContain("TM-1042");
    expect(draft).toContain("$84.17");
    expect(draft).toContain("Test Merchant");
    expect(draft).toContain("Fair Credit Billing Act");
    expect(draft).toContain("2026-09-01");
    expect(draft.toLowerCase()).toContain("not legal advice");
    // The merchant's own phrasing must never reach the customer's letter.
    expect(draft.toLowerCase()).not.toContain("final answer");
    expect(draft.toLowerCase()).not.toContain("nothing else we can do");

    // Content-identical merchant repeats (the stonewall script sends the same
    // "final answer" every time) are deduped in the message log AND don't
    // append duplicate merchant_reply evidence rows — but they still counted
    // as deflection signals, which is why the ladder reached rung 5.
    const replyEvidence = (detail.evidence ?? []).filter((e: any) => e.kind === "merchant_reply");
    expect(replyEvidence.length).toBe(1);
    const inboundDupes = (detail.events ?? []).filter(
      (e: any) => e.type === "message_received" && e.data?.duplicate === true,
    );
    expect(inboundDupes.length).toBeGreaterThanOrEqual(1);

    // Approving materializes the letter + a generated evidence-bundle PDF.
    const dr = await apiPost(c, `/api/approvals/${approval.id}/decide`, { optionId: "approve" });
    expect(dr.status).toBe(200);
    const after = await getCaseDetail(c, caseId);
    const evKinds = (after.evidence ?? []).map((e: any) => e.kind);
    expect(evKinds).toContain("pdf");
    const pdfEv = (after.evidence ?? []).find((e: any) => e.kind === "pdf");
    expect(pdfEv.hasFile).toBeTruthy();
    const file = await SELF.fetch(`http://test/api/cases/${caseId}/evidence/${pdfEv.id}/file`, {
      headers: authed(c),
    });
    expect(file.status).toBe(200);
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("%PDF");

    // The on-demand bundle endpoint also serves a real PDF.
    const bundle = await SELF.fetch(`http://test/api/cases/${caseId}/bundle.pdf`, { headers: authed(c) });
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("application/pdf");

    // Rung 6: a missed supervisor deadline drives the complaint drafts.
    await forceDeadlineDue(caseId, "supervisor_response");
    await runFollowUpSweep(env as any);
    const d6 = await runUntil(c, caseId, (d) =>
      (d.approvals ?? []).some((a: any) => a.status === "pending" && a.detail?.payload?.drafts),
    );
    const complaint = (d6.approvals ?? []).find(
      (a: any) => a.status === "pending" && a.detail?.payload?.drafts,
    );
    expect(complaint, "rung-6 complaint-drafts approval card").toBeTruthy();
    const agencies = (complaint.detail.payload.drafts as any[]).map((x) => x.agency).join("|");
    expect(agencies).toMatch(/FTC/);
    expect(agencies).toMatch(/Better Business Bureau/);
    // CFPB is gated to financial-product issues — never for a retail return.
    expect(agencies).not.toMatch(/Consumer Financial Protection/);
  });

  it("resets the streak on a substantive reply (deflection → promise)", async () => {
    const c = await signup(`esc-df-${Date.now()}@test.dev`);
    const caseId = await createTestCase(c, INTAKE, "deflection");
    await grantMandate(c, caseId);
    const detail = await runUntil(c, caseId, (d) => d.outcome?.status === "PROMISED");
    expect(detail.outcome?.status).toBe("PROMISED");
    // Two deflections → exactly rung 1; the promise stops the climb.
    const rungs = (detail.escalations ?? []).map((e: any) => e.rung);
    expect(rungs).toEqual([1]);
    // The promise created a MERCHANT_STATED deadline.
    const dl = (detail.deadlines ?? []).map((d: any) => `${d.kind}:${d.source}`);
    expect(dl).toContain("promised_date:MERCHANT_STATED");
  });

  it("a missed promised-date deadline advances the ladder via the sweep", async () => {
    const c = await signup(`esc-pd-${Date.now()}@test.dev`);
    const caseId = await createTestCase(c, INTAKE, "deflection");
    await grantMandate(c, caseId);
    await runUntil(c, caseId, (d) => d.outcome?.status === "PROMISED");
    // The merchant's promise lapses → sweep marks it missed and advances a rung.
    await forceDeadlineDue(caseId, "promised_date");
    const res = await runFollowUpSweep(env as any);
    expect(res.deadlines?.missed).toBeGreaterThanOrEqual(1);
    const detail = await getCaseDetail(c, caseId);
    const dl = (detail.deadlines ?? []).find((d: any) => d.kind === "promised_date" && d.status === "missed");
    expect(dl).toBeTruthy();
    const rungs = (detail.escalations ?? []).map((e: any) => e.rung);
    expect(rungs).toEqual([1, 2]); // rung 1 from deflections, rung 2 from the missed promise
  });
});

describe("M3 — deflection detection units", () => {
  it("flags empathy-without-action and no-action phrases", () => {
    expect(
      detectDeflection("I completely understand how frustrating this must be, but there is nothing else we can do at this time.").deflection,
    ).toBe(true);
    expect(
      detectDeflection("We are simply not able to offer you anything further.").signals,
    ).toContain("no_action_phrase");
    expect(
      detectDeflection("Per our returns policy, this item is not eligible for a refund.").signals,
    ).toContain("policy_wall_without_citation");
  });

  it("does not flag substantive replies", () => {
    expect(
      detectDeflection("Your refund of $84.17 has been approved and will arrive within 5 business days. Reference TM-4471.").deflection,
    ).toBe(false);
    expect(detectDeflection("Your refund was issued today.").deflection).toBe(false);
  });

  it("flags repeated non-answers", () => {
    const first = "We are looking into your case and will update you soon.";
    const dup = "We are looking into your case and will update you soon.";
    expect(detectDeflection(dup, [first]).signals).toContain("repeat_non_answer");
  });
});

describe("M3 — pdf + template units", () => {
  it("buildPdf emits a valid multi-page PDF", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} of a long record`);
    const pdf = buildPdf("test", lines);
    const head = String.fromCharCode(...pdf.slice(0, 8));
    expect(head).toContain("%PDF-1.");
    const text = new TextDecoder().decode(pdf);
    expect(text).toContain("%%EOF");
    expect(text).toContain("/Type /Pages");
  });

  it("wrapText wraps at the column bound", () => {
    const wrapped = wrapText("word ".repeat(40).trim(), 20);
    for (const w of wrapped) expect(w.length).toBeLessThanOrEqual(20);
  });
});
