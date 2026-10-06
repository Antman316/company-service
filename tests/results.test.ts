import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  apiPost, apiGet, createTestCase, forceFollowUpDue, getCaseDetail, grantMandate, signup,
} from "./helpers";
import { runFollowUpSweep } from "../src/core/agent";

// M4 — results & money verification. RECEIVED splits by evidence source;
// VERIFIED_RESOLVED requires a document on file + customer confirm.

async function driveToIssued(c: Awaited<ReturnType<typeof signup>>) {
  const caseId = await createTestCase(
    c,
    "Test Merchant owes me $84.17 for a returned item. Order TM-77.",
    "standard_refund_flow",
  );
  await grantMandate(c, caseId);
  let d = await getCaseDetail(c, caseId);
  expect(d.outcome.status).toBe("PROMISED"); // merchant stated, not verified
  await forceFollowUpDue(caseId);
  await runFollowUpSweep(env as any);
  d = await getCaseDetail(c, caseId);
  expect(d.outcome.status).toBe("ISSUED");
  const receiptApproval = d.approvals.find((a: any) => a.kind === "confirm_receipt" && a.status === "pending");
  expect(receiptApproval).toBeTruthy();
  return { caseId, receiptApproval, d };
}

describe("M4 — receipt tiers", () => {
  it("customer-confirm + document → VERIFIED_RESOLVED", async () => {
    const c = await signup("m4a@test.dev");
    const { caseId, receiptApproval } = await driveToIssued(c);

    await apiPost(c, `/api/approvals/${receiptApproval.id}/decide`, { optionId: "received" });
    let d = await getCaseDetail(c, caseId);
    expect(d.outcome.status).toBe("RECEIVED");
    expect(d.receipt.tier).toBe("customer_confirmed");
    expect(d.case.status).toBe("RESOLUTION_PROPOSED");

    // Document arrives → tier upgrades, confirm_resolution asked.
    const r = await apiPost(c, `/api/cases/${caseId}/receipt-evidence`, {
      text: "Test Merchant: your refund of $84.17 for order TM-77 was issued to Visa ••4242. Ref TM-4471.",
    });
    expect(r.status).toBe(200);
    expect(r.body.tier).toBe("document_verified");
    expect(r.body.amountCents).toBe(8417);

    d = await getCaseDetail(c, caseId);
    expect(d.receipt.tier).toBe("document_verified");
    // verify_receipt was already pending → no duplicate confirm_resolution.
    const verify = d.approvals.find((a: any) => a.kind === "verify_receipt" && a.status === "pending");
    expect(verify).toBeTruthy();
    expect(d.evidence.some((e: any) => e.kind === "receipt" && /Refund confirmation/.test(e.label ?? ""))).toBe(true);

    await apiPost(c, `/api/approvals/${verify.id}/decide`, { optionId: "close" });
    d = await getCaseDetail(c, caseId);
    expect(d.outcome.status).toBe("VERIFIED_RESOLVED");
    expect(d.case.status).toBe("RESOLVED");
    expect(d.receipt.tier).toBe("verified_resolved");
    expect(d.results.amount_recovered).toBe(8417);
    expect(d.results.escalation_max_rung).toBeGreaterThanOrEqual(0);
    expect(typeof d.results.agent_messages_sent).toBe("number");
  });

  it("partial receipt records the partial amount and keeps the case working", async () => {
    const c = await signup("m4b@test.dev");
    const { caseId, receiptApproval } = await driveToIssued(c);

    await apiPost(c, `/api/approvals/${receiptApproval.id}/decide`, { optionId: "partial", amountCents: 5000 });
    let d = await getCaseDetail(c, caseId);
    expect(d.outcome.status).toBe("RECEIVED");
    expect(d.results.amount_recovered).toBe(5000);
    const verify = d.approvals.find((a: any) => a.kind === "verify_receipt" && a.status === "pending");
    expect(verify).toBeTruthy();

    // Keep pursuing → back to REQUESTED trail + waiting on company.
    await apiPost(c, `/api/approvals/${verify.id}/decide`, { optionId: "keep_following" });
    d = await getCaseDetail(c, caseId);
    expect(d.outcome.status).toBe("REQUESTED");
    expect(d.case.status).toBe("WAITING_FOR_COMPANY");
    expect(d.receipt.tier).toBe("customer_confirmed");
  });

  it("close without document resolves at customer-confirmed tier only", async () => {
    const c = await signup("m4c@test.dev");
    const { caseId, receiptApproval } = await driveToIssued(c);
    await apiPost(c, `/api/approvals/${receiptApproval.id}/decide`, { optionId: "received" });
    let d = await getCaseDetail(c, caseId);
    const verify = d.approvals.find((a: any) => a.kind === "verify_receipt" && a.status === "pending");
    await apiPost(c, `/api/approvals/${verify.id}/decide`, { optionId: "close" });
    d = await getCaseDetail(c, caseId);
    expect(d.case.status).toBe("RESOLVED");
    expect(d.outcome.status).toBe("RECEIVED");
    expect(d.receipt.tier).toBe("customer_confirmed"); // never VERIFIED_RESOLVED
  });

  it("not_received keeps the case in follow-up", async () => {
    const c = await signup("m4d@test.dev");
    const { caseId, receiptApproval } = await driveToIssued(c);
    await apiPost(c, `/api/approvals/${receiptApproval.id}/decide`, { optionId: "not_received" });
    const d = await getCaseDetail(c, caseId);
    expect(d.outcome.status).toBe("REQUESTED");
    expect(d.case.status).toBe("WAITING_FOR_COMPANY");
    expect(d.receipt.tier).toBe("none");
  });

  it("starting state lands in meta.results and results aggregate is public", async () => {
    const c = await signup("m4e@test.dev");
    const r = await apiPost(c, "/api/cases", {
      text: "Test Merchant owes me $42.00 for a returned item. Order TM-99.",
      startingState: { daysOverdue: 21, priorAttempts: 2, refundInProgress: false },
    });
    expect(r.status).toBe(200);
    const d = await getCaseDetail(c, r.body.caseId);
    expect(d.results.days_overdue_at_start).toBe(21);
    expect(d.results.prior_customer_attempts).toBe(2);
    expect(d.results.refund_already_in_progress).toBe(false);
    expect(d.results.amount_claimed).toBe(4200);

    // /api/results is public — no session. Other tests in this file already
    // pushed Test Merchant past the sample floor, so it gets a named bucket.
    const pub = await apiGet(c, "/api/results");
    expect(pub.status).toBe(200);
    expect(pub.body.total.cases).toBeGreaterThanOrEqual(1);
    expect(pub.body.byMerchant["Test Merchant"]?.cases).toBeGreaterThanOrEqual(3);
    expect(pub.body.caveat).toBeTruthy();
  });
});
