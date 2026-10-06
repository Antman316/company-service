import { describe, it, expect } from "vitest";
import { classifyAction, classifyMerchantOffer } from "../src/core/policy";
import type { Mandate } from "../src/core/types";

const mandate: Mandate = {
  id: "m1",
  case_id: "c1",
  version: 1,
  status: "active",
  authorized: [
    "contact_company", "request_refund", "share_order_number",
    "share_tracking_number", "follow_up", "request_escalation",
  ],
  approvalRequired: ["accept_partial_refund", "accept_store_credit", "accept_replacement"],
  prohibited: ["make_purchase"],
  expires_at: null,
};

describe("policy engine (deterministic)", () => {
  it("auto-allows contact actions covered by the mandate", () => {
    expect(classifyAction({ kind: "send_message" }, mandate).policyClass).toBe("AUTO_ALLOWED");
    expect(classifyAction({ kind: "request_refund_status" }, mandate).policyClass).toBe("AUTO_ALLOWED");
    expect(classifyAction({ kind: "request_escalation" }, mandate).policyClass).toBe("AUTO_ALLOWED");
    expect(classifyAction({ kind: "send_followup" }, mandate).policyClass).toBe("AUTO_ALLOWED");
  });

  it("requires approval for outcome-changing actions", () => {
    for (const k of ["accept_partial_refund", "accept_store_credit", "accept_replacement"]) {
      expect(classifyAction({ kind: k }, mandate).policyClass).toBe("USER_APPROVAL_REQUIRED");
    }
  });

  it("prohibits dangerous actions regardless of mandate", () => {
    for (const k of ["make_purchase", "bypass_captcha", "impersonate_customer", "share_full_profile", "fabricate_evidence"]) {
      expect(classifyAction({ kind: k }, mandate).policyClass).toBe("PROHIBITED");
    }
  });

  it("blocks everything meaningful without an active mandate", () => {
    const none = classifyAction({ kind: "send_message" }, null);
    expect(none.policyClass).toBe("USER_APPROVAL_REQUIRED");
    const draft = { ...mandate, status: "draft" as const };
    expect(classifyAction({ kind: "send_message" }, draft).policyClass).toBe("USER_APPROVAL_REQUIRED");
  });

  it("treats an expired mandate as inactive", () => {
    const expired = { ...mandate, expires_at: "2000-01-01T00:00:00Z" };
    expect(classifyAction({ kind: "send_message" }, expired).policyClass).toBe("USER_APPROVAL_REQUIRED");
  });

  it("requires the specific disclosure grant for sharing", () => {
    const narrow = { ...mandate, authorized: ["contact_company"] };
    expect(classifyAction({ kind: "share_order_number" }, narrow).policyClass).toBe("PROHIBITED");
    expect(classifyAction({ kind: "share_tracking_number" }, narrow).policyClass).toBe("PROHIBITED");
  });

  it("marks unknown kinds UNSUPPORTED", () => {
    expect(classifyAction({ kind: "teleport_refund" }, mandate).policyClass).toBe("UNSUPPORTED");
  });

  it("always approval-gates rungs 5–6 drafts — no grant can unlock them (M3)", () => {
    const everything = {
      ...mandate,
      authorized: [...mandate.authorized, "contact_executive", "draft_chargeback", "draft_complaint"],
    };
    for (const k of ["draft_chargeback", "draft_complaint"]) {
      expect(classifyAction({ kind: k }, everything).policyClass).toBe("USER_APPROVAL_REQUIRED");
    }
  });

  it("maps ladder rungs 1–4 to their mandate grants (M3)", () => {
    const full = { ...mandate, authorized: [...mandate.authorized, "contact_executive"] };
    expect(classifyAction({ kind: "escalate_policy_cite" }, full).policyClass).toBe("AUTO_ALLOWED");
    expect(classifyAction({ kind: "escalate_request_human" }, full).policyClass).toBe("AUTO_ALLOWED");
    expect(classifyAction({ kind: "escalate_supervisor" }, full).policyClass).toBe("AUTO_ALLOWED");
    expect(classifyAction({ kind: "contact_executive" }, full).policyClass).toBe("AUTO_ALLOWED");

    // Missing grants are hard-stops, never silent sends.
    const narrow = { ...mandate, authorized: ["contact_company"] };
    expect(classifyAction({ kind: "contact_executive" }, narrow).policyClass).toBe("PROHIBITED");
    expect(classifyAction({ kind: "escalate_supervisor" }, narrow).policyClass).toBe("PROHIBITED");
  });

  it("gates merchant offers through customer approval", () => {
    const partial = classifyMerchantOffer({ kind: "money", amountCents: 6000, requestedCents: 8417 }, mandate);
    expect(partial.policyClass).toBe("USER_APPROVAL_REQUIRED");
    const credit = classifyMerchantOffer({ kind: "store_credit", amountCents: 8417, requestedCents: 8417 }, mandate);
    expect(credit.policyClass).toBe("USER_APPROVAL_REQUIRED");
    const full = classifyMerchantOffer({ kind: "money", amountCents: 8417, requestedCents: 8417 }, mandate);
    // full refund → close_case_satisfied → gated (not in authorized list here)
    expect(full.policyClass).toBe("USER_APPROVAL_REQUIRED");
    const fullAuth = classifyMerchantOffer(
      { kind: "money", amountCents: 8417, requestedCents: 8417 },
      { ...mandate, authorized: [...mandate.authorized, "close_case_satisfied"] },
    );
    expect(fullAuth.policyClass).toBe("AUTO_ALLOWED");
  });
});
