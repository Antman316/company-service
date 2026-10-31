// Company Service — core domain types.
// Everything the product knows about a case lives here. Anything originating
// outside this system (merchant text, emails, web pages, tool output) is
// UNTRUSTED data — never instructions.

// ---------- Case state machine ----------
export const CASE_STATES = [
  "DRAFT",
  "NEEDS_INFORMATION",
  "READY",
  "AWAITING_AUTHORIZATION",
  "PLANNING",
  "IN_PROGRESS",
  "WAITING_FOR_COMPANY",
  "WAITING_FOR_CUSTOMER",
  "FOLLOW_UP_DUE",
  "ESCALATION_REQUIRED",
  "RESOLUTION_PROPOSED",
  "RESOLVED",
  "UNRESOLVED",
  "UNSUPPORTED",
  "CANCELLED",
] as const;
export type CaseState = (typeof CASE_STATES)[number];

// Allowed transitions. The engine refuses anything outside this table.
export const CASE_TRANSITIONS: Record<CaseState, CaseState[]> = {
  DRAFT: ["NEEDS_INFORMATION", "READY", "CANCELLED"],
  NEEDS_INFORMATION: ["READY", "CANCELLED"],
  READY: ["AWAITING_AUTHORIZATION", "PLANNING", "UNSUPPORTED", "CANCELLED"],
  AWAITING_AUTHORIZATION: ["PLANNING", "WAITING_FOR_CUSTOMER", "CANCELLED"],
  PLANNING: ["IN_PROGRESS", "UNSUPPORTED", "AWAITING_AUTHORIZATION", "CANCELLED"],
  IN_PROGRESS: [
    "WAITING_FOR_COMPANY",
    "WAITING_FOR_CUSTOMER",
    "FOLLOW_UP_DUE",
    "RESOLUTION_PROPOSED",
    "ESCALATION_REQUIRED",
    "RESOLVED",
    "UNRESOLVED",
    "UNSUPPORTED",
    "CANCELLED",
  ],
  WAITING_FOR_COMPANY: [
    "IN_PROGRESS",
    "FOLLOW_UP_DUE",
    "WAITING_FOR_CUSTOMER",
    "ESCALATION_REQUIRED",
    "RESOLUTION_PROPOSED",
    "RESOLVED",
    "UNRESOLVED",
    "CANCELLED",
  ],
  WAITING_FOR_CUSTOMER: [
    "IN_PROGRESS",
    "WAITING_FOR_COMPANY",
    "NEEDS_INFORMATION",
    "AWAITING_AUTHORIZATION",
    "RESOLUTION_PROPOSED",
    "UNRESOLVED",
    "CANCELLED",
  ],
  FOLLOW_UP_DUE: [
    "IN_PROGRESS",
    "WAITING_FOR_COMPANY",
    "ESCALATION_REQUIRED",
    "RESOLUTION_PROPOSED",
    "RESOLVED",
    "UNRESOLVED",
    "CANCELLED",
  ],
  ESCALATION_REQUIRED: ["IN_PROGRESS", "WAITING_FOR_COMPANY", "UNRESOLVED", "CANCELLED"],
  RESOLUTION_PROPOSED: ["RESOLVED", "UNRESOLVED", "IN_PROGRESS", "WAITING_FOR_COMPANY", "CANCELLED"],
  RESOLVED: [],
  UNRESOLVED: ["IN_PROGRESS", "CANCELLED"],
  UNSUPPORTED: ["CANCELLED"],
  CANCELLED: [],
};

// ---------- Claim / evidence provenance ----------
export const CLAIM_STATUSES = [
  "CUSTOMER_STATED",
  "DOCUMENT_VERIFIED",
  "MERCHANT_STATED",
  "SYSTEM_VERIFIED",
  "INFERRED",
  "CONFLICTING",
  "UNKNOWN",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const EVIDENCE_KINDS = [
  "statement",
  "image",
  "pdf",
  "receipt",
  "email",
  "merchant_reply",
  "screenshot",
  "tracking",
  "order_info",
  "note",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

// ---------- Policy ----------
export const POLICY_CLASSES = [
  "AUTO_ALLOWED",
  "USER_APPROVAL_REQUIRED",
  "PROHIBITED",
  "UNSUPPORTED",
] as const;
export type PolicyClass = (typeof POLICY_CLASSES)[number];

// ---------- Outcomes (never conflate) ----------
export const OUTCOME_STATUSES = [
  "REQUESTED",
  "ACKNOWLEDGED",
  "PROMISED",
  "APPROVED",
  "ISSUED",
  "RECEIVED",
  "VERIFIED_RESOLVED",
  "DENIED",
  "UNRESOLVED",
] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

// ---------- Coverage ----------
export const AUTOMATION_LEVELS = [
  "AUTOMATED",
  "ASSISTED",
  "MANUAL_HANDOFF",
  "TEMPORARILY_UNAVAILABLE",
  "UNSUPPORTED",
] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

export const VERIFICATION_STATUSES = [
  "VERIFIED",
  "SIMULATED",
  "ASSISTED",
  // Channel confirmed published on the merchant's official site — a lower
  // label than VERIFIED (R7): real contact through the lane hasn't been
  // observed yet, but the address isn't guessed.
  "CONTACT_CONFIRMED",
  "UNVERIFIED",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const ISSUE_TYPES = [
  "refund_not_received",
  "return_refund_pending",
  "wrong_item",
  "damaged_item",
  "missing_item",
  "incomplete_order",
  "order_status",
  "other_post_purchase",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

// ---------- Row shapes (as stored in D1) ----------
export interface CaseRow {
  id: string;
  user_id: string;
  company_id: string | null;
  company_name: string | null;
  title: string;
  issue_type: string | null;
  desired_outcome: string | null;
  amount_cents: number | null;
  currency: string | null;
  status: CaseState;
  status_reason: string | null;
  paused: number;
  meta: string | null;
  intake_text: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface Mandate {
  id: string;
  case_id: string;
  version: number;
  status: "draft" | "active" | "revoked" | "expired";
  authorized: string[];      // action grants, e.g. "request_refund", "share_order_number"
  approvalRequired: string[];
  prohibited: string[];
  expires_at: string | null;
}

export interface ApprovalOption {
  id: string;
  label: string;
  kind: "approve" | "reject" | "custom";
}

export interface CoverageQuery {
  companyId?: string;
  companyName?: string;
  issueType?: string;
  channel?: string;
}

export interface CoverageResult {
  coverage: "covered" | "assisted" | "uncovered";
  automationLevel: AutomationLevel;
  verificationStatus: VerificationStatus;
  adapterId?: string;
  channel?: string;
  /** Concrete destination for this channel (support email, chat/portal URL). */
  channelAddress?: string;
  limitations?: string;
  reason: string;
}

// ---------- Model provider layer ----------
export type ModelRole = "light" | "reasoning" | "vision";

export interface ModelRequest {
  role: ModelRole;
  system: string;                       // system policy — controlled by us
  userContext: string;                  // user authority + case objective
  untrustedContent?: string;            // clearly delimited, never instructions
  responseFormat?: "text" | "json";
  schemaHint?: string;
  maxTokens?: number;
  images?: { mime: string; dataBase64: string }[];
}

export interface ModelResponse {
  providerId: string;
  model: string;
  text: string;
  tokensIn?: number;
  tokensOut?: number;
  costMicroUsd?: number;
}

export interface ModelCapabilities {
  roles: ModelRole[];
  structuredOutput: boolean;
  vision: boolean;
  liveVerified: boolean;   // whether this provider has ever returned a real response
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
  checkedAt: string;
}

export interface ModelProvider {
  id: string;
  capabilities(): Promise<ModelCapabilities>;
  execute(request: ModelRequest): Promise<ModelResponse>;
  healthCheck(): Promise<ProviderHealth>;
}

// ---------- Company adapters ----------
export interface CompanyAction {
  kind: string;                          // "send_message" | "send_email" | "check_status" | ...
  payload: Record<string, unknown>;
}

export interface ExecutionContext {
  caseId: string;
  userId: string;
  companyName: string;
  conversationId?: string;
  env: Env;
  now: () => string;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  externalRef?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface ExternalCaseReference {
  adapterId: string;
  externalRef: string;
}

export interface ExternalStatus {
  status: string;
  detail?: string;
}

export interface CompanyAdapter {
  companyId: string;
  checkCoverage(request: CoverageQuery): Promise<CoverageResult>;
  execute(action: CompanyAction, context: ExecutionContext): Promise<ActionResult>;
  getStatus?(reference: ExternalCaseReference): Promise<ExternalStatus>;
}
