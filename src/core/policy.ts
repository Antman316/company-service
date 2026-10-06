import type { Mandate, PolicyClass } from "./types";

// ---------------------------------------------------------------------------
// Deterministic action policy. This is deliberately NOT a model: the same
// action always classifies the same way. Model output can never widen it.
// ---------------------------------------------------------------------------

export interface ProposedAction {
  kind: string;
  payload?: Record<string, unknown>;
}

// Actions that are never permitted in V1 regardless of mandate.
const PROHIBITED_ALWAYS = new Set([
  "make_purchase",
  "bank_transfer",
  "accept_legal_settlement",
  "submit_false_statement",
  "fabricate_evidence",
  "bypass_authentication",
  "bypass_captcha",
  "impersonate_customer",
  "change_security_credentials",
  "share_full_profile",
  "share_unrelated_data",
]);

// Actions the platform does not implement yet — they surface as UNSUPPORTED,
// never silently attempted.
const KNOWN_ACTION_KINDS = new Set([
  "send_message",          // chat-channel message to merchant
  "send_email",            // email-channel message to merchant
  "request_refund_status", // ask where the refund is
  "share_order_number",
  "share_tracking_number",
  "share_evidence",        // share a specific piece of case evidence
  "request_case_number",
  "request_escalation",
  "send_followup",
  "check_merchant_status",
  // escalation ladder rungs (M3)
  "escalate_policy_cite",     // rung 1 — restate + cite merchant policy
  "escalate_request_human",   // rung 2 — human agent / reference number
  "escalate_supervisor",      // rung 3 — supervisor + explicit deadline
  "contact_executive",        // rung 4 — executive/corporate relations
  "draft_chargeback",         // rung 5 — card-dispute draft (customer files)
  "draft_complaint",          // rung 6 — regulator complaint drafts (customer files)
  // approval-gated
  "accept_partial_refund",
  "accept_store_credit",
  "accept_replacement",
  "agree_to_fee",
  "change_delivery",
  "accept_new_terms",
  "close_case_satisfied",
  // prohibited (declared so they classify deterministically)
  ...PROHIBITED_ALWAYS,
]);

// Kinds that require approval unless the mandate explicitly grants them.
const APPROVAL_BY_DEFAULT = new Set([
  "accept_partial_refund",
  "accept_store_credit",
  "accept_replacement",
  "agree_to_fee",
  "change_delivery",
  "accept_new_terms",
  "close_case_satisfied",
]);

// Drafts the customer files themselves. The system can never file them, so
// they are always approval-gated regardless of what the mandate authorizes.
const DRAFT_ONLY = new Set(["draft_chargeback", "draft_complaint"]);

// Information categories an action might disclose; each must be granted.
const DISCLOSURE_REQUIRED: Record<string, string> = {
  share_order_number: "share_order_number",
  share_tracking_number: "share_tracking_number",
  share_evidence: "share_evidence",
};

export interface PolicyDecision {
  policyClass: PolicyClass;
  reason: string;
}

export function classifyAction(action: ProposedAction, mandate: Mandate | null): PolicyDecision {
  const kind = action.kind;

  if (!KNOWN_ACTION_KINDS.has(kind)) {
    return { policyClass: "UNSUPPORTED", reason: `unknown action kind "${kind}"` };
  }
  if (PROHIBITED_ALWAYS.has(kind)) {
    return { policyClass: "PROHIBITED", reason: `"${kind}" is prohibited in V1` };
  }

  // No active mandate → only read-only status checks may proceed, and even
  // those require READY-state handling upstream. Everything else needs the
  // customer to grant authority first.
  const active = mandate && mandate.status === "active";
  const expired = mandate && mandate.status === "active" && mandate.expires_at != null &&
    new Date(mandate.expires_at).getTime() < Date.now();
  if (expired) {
    return { policyClass: "USER_APPROVAL_REQUIRED", reason: "mandate expired" };
  }
  if (!active) {
    return {
      policyClass: "USER_APPROVAL_REQUIRED",
      reason: "no active mandate — customer authorization required",
    };
  }

  const authorized = new Set(mandate.authorized);
  const approvals = new Set(mandate.approvalRequired);
  const prohibited = new Set(mandate.prohibited);

  if (prohibited.has(kind)) {
    return { policyClass: "PROHIBITED", reason: `"${kind}" prohibited by this case's mandate` };
  }

  // A disclosure action needs its specific grant, not a generic "share data".
  const disclosureGrant = DISCLOSURE_REQUIRED[kind];
  if (disclosureGrant && !authorized.has(disclosureGrant)) {
    return approvals.has(disclosureGrant)
      ? { policyClass: "USER_APPROVAL_REQUIRED", reason: `sharing ${kind} needs customer approval` }
      : { policyClass: "PROHIBITED", reason: `mandate does not authorize ${kind}` };
  }

  if (DRAFT_ONLY.has(kind)) {
    return {
      policyClass: "USER_APPROVAL_REQUIRED",
      reason: `"${kind}" produces a document the customer reviews and files themselves — never sent or filed by the system`,
    };
  }

  if (APPROVAL_BY_DEFAULT.has(kind)) {
    return authorized.has(kind)
      ? { policyClass: "AUTO_ALLOWED", reason: `"${kind}" explicitly authorized` }
      : { policyClass: "USER_APPROVAL_REQUIRED", reason: `"${kind}" requires customer approval` };
  }

  // Ordinary contact actions must be covered by a grant. Map common kinds to
  // the grants a mandate would name.
  const grantNeeded = kindToGrant(kind);
  if (grantNeeded && !authorized.has(grantNeeded)) {
    return approvals.has(grantNeeded)
      ? { policyClass: "USER_APPROVAL_REQUIRED", reason: `"${kind}" needs customer approval` }
      : { policyClass: "PROHIBITED", reason: `mandate does not authorize ${kind}` };
  }

  return { policyClass: "AUTO_ALLOWED", reason: `"${kind}" authorized` };
}

function kindToGrant(kind: string): string | null {
  switch (kind) {
    case "send_message":
    case "send_email":
      return "contact_company";
    case "request_refund_status":
      return "request_refund";
    case "request_case_number":
      return "contact_company";
    case "request_escalation":
      return "request_escalation";
    case "send_followup":
      return "follow_up";
    case "escalate_policy_cite":
      return "request_refund";
    case "escalate_request_human":
    case "escalate_supervisor":
      return "request_escalation";
    case "contact_executive":
      return "contact_executive";
    case "check_merchant_status":
      return "contact_company";
    default:
      return kind;
  }
}

// Offered-resolution gate: when a merchant offer arrives, decide whether the
// agent may accept it autonomously. Returns null if the offer doesn't map to a
// gated action, else the decision.
export function classifyMerchantOffer(
  offer: { kind: "money" | "store_credit" | "replacement" | "other"; amountCents?: number; requestedCents?: number },
  mandate: Mandate | null,
): PolicyDecision {
  if (offer.kind === "money" && offer.amountCents != null && offer.requestedCents != null) {
    if (offer.amountCents >= offer.requestedCents) {
      return classifyAction({ kind: "close_case_satisfied" }, mandate);
    }
    return classifyAction({ kind: "accept_partial_refund" }, mandate);
  }
  if (offer.kind === "store_credit") return classifyAction({ kind: "accept_store_credit" }, mandate);
  if (offer.kind === "replacement") return classifyAction({ kind: "accept_replacement" }, mandate);
  return { policyClass: "USER_APPROVAL_REQUIRED", reason: "unrecognized offer kind" };
}
