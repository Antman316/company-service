import { json, q, q1 } from "./db";
import type { CaseRow } from "./types";

// ---------------------------------------------------------------------------
// Fixed templates for rungs 5–6 and the evidence bundle.
//
// INVARIANT (R3): merchant message text is never an input to these documents.
// Facts are assembled only from:
//   - case row fields (company, order ref, amount, issue type, outcome sought)
//   - case_claims with non-merchant provenance (CUSTOMER_STATED,
//     DOCUMENT_VERIFIED, SYSTEM_VERIFIED, INFERRED — never source_type='merchant')
//   - outcome_events (our own templated ledger entries)
//   - case_deadlines (sourced-labeled dates)
//   - case_evidence metadata (kind/label/hash — not merchant bodies)
//   - external_messages counts/dates (contact history stats, never bodies)
//   - cases.meta.cardType / statementDate (customer-entered facts)
// No free-form model text, no merchant prose. A prompt-injected merchant reply
// cannot steer a letter written in the customer's name.
// ---------------------------------------------------------------------------

export interface CaseFacts {
  caseId: string;
  company: string;
  orderRef: string | null;
  trackingRef: string | null;
  amountCents: number | null;
  currency: string;
  issueType: string;
  desiredOutcome: string;
  cardType: "credit" | "debit" | "unknown";
  statementDate: string | null;
  claims: { text: string; status: string }[];
  outcomes: { status: string; detail: string; at: string }[];
  deadlines: { kind: string; dueAt: string; source: string; status: string }[];
  evidence: { kind: string; label: string | null; sha256: string | null; sizeBytes: number | null }[];
  contactCount: number;
  firstContactAt: string | null;
  lastContactAt: string | null;
  maxRung: number;
}

export async function gatherCaseFacts(db: D1Database, caseRow: CaseRow): Promise<CaseFacts> {
  const meta = json<{ orderRef?: string; trackingRef?: string; cardType?: string; statementDate?: string }>(
    caseRow.meta, {},
  );
  const claims = await q<{ text: string; claim_status: string }>(
    db,
    `SELECT text, claim_status FROM case_claims
     WHERE case_id = ? AND COALESCE(source_type,'customer') != 'merchant' ORDER BY created_at ASC`,
    caseRow.id,
  );
  const outcomes = await q<{ status: string; detail: string; created_at: string }>(
    db,
    `SELECT status, detail, created_at FROM outcome_events WHERE case_id = ? ORDER BY created_at ASC`,
    caseRow.id,
  );
  const deadlines = await q<{ kind: string; due_at: string; source: string; status: string }>(
    db,
    `SELECT kind, due_at, source, status FROM case_deadlines WHERE case_id = ? ORDER BY due_at ASC`,
    caseRow.id,
  );
  const evidence = await q<{ kind: string; label: string | null; sha256: string | null; size_bytes: number | null }>(
    db,
    `SELECT kind, label, sha256, size_bytes FROM case_evidence WHERE case_id = ? ORDER BY created_at ASC`,
    caseRow.id,
  );
  const contact = await q1<{ n: number; first: string | null; last: string | null }>(
    db,
    `SELECT COUNT(*) AS n, MIN(m.created_at) AS first, MAX(m.created_at) AS last
     FROM external_messages m JOIN external_conversations c ON c.id = m.conversation_id
     WHERE c.case_id = ? AND m.direction = 'out' AND m.status IN ('sent','queued','drafted')`,
    caseRow.id,
  );
  const rungRow = await q1<{ m: number | null }>(
    db,
    `SELECT MAX(rung) AS m FROM case_escalations WHERE case_id = ? AND status != 'skipped'`,
    caseRow.id,
  );
  return {
    caseId: caseRow.id,
    company: caseRow.company_name ?? "the merchant",
    orderRef: meta.orderRef ?? null,
    trackingRef: meta.trackingRef ?? null,
    amountCents: caseRow.amount_cents,
    currency: caseRow.currency ?? "USD",
    issueType: caseRow.issue_type ?? "other_post_purchase",
    desiredOutcome: caseRow.desired_outcome ?? "the requested resolution",
    cardType: meta.cardType === "credit" || meta.cardType === "debit" ? meta.cardType : "unknown",
    statementDate: meta.statementDate ?? null,
    claims: claims.map((c) => ({ text: c.text, status: c.claim_status })),
    outcomes: outcomes.map((o) => ({ status: o.status, detail: o.detail, at: o.created_at })),
    deadlines: deadlines.map((d) => ({ kind: d.kind, dueAt: d.due_at, source: d.source, status: d.status })),
    evidence: evidence.map((e) => ({ kind: e.kind, label: e.label, sha256: e.sha256, sizeBytes: e.size_bytes })),
    contactCount: contact?.n ?? 0,
    firstContactAt: contact?.first ?? null,
    lastContactAt: contact?.last ?? null,
    maxRung: rungRow?.m ?? 0,
  };
}

const NOT_LEGAL_ADVICE =
  "This document was prepared by software from the customer's case records. It is not legal advice, " +
  "does not create an attorney-client relationship, and is provided without warranty. The customer is " +
  "responsible for reviewing it for accuracy before filing.";

function money(f: CaseFacts): string {
  return f.amountCents != null ? `$${(f.amountCents / 100).toFixed(2)} ${f.currency}` : "the disputed amount";
}

function header(f: CaseFacts, title: string): string[] {
  return [
    title,
    "=".repeat(Math.min(title.length, 72)),
    "",
    `Merchant: ${f.company}`,
    ...(f.orderRef ? [`Order reference: ${f.orderRef}`] : []),
    ...(f.trackingRef ? [`Tracking reference: ${f.trackingRef}`] : []),
    `Amount in dispute: ${money(f)}`,
    `Issue type: ${f.issueType.replace(/_/g, " ")}`,
    `Requested resolution: ${f.desiredOutcome}`,
    `Contact attempts by customer's representative: ${f.contactCount}` +
      (f.firstContactAt ? ` (first ${f.firstContactAt.slice(0, 10)}` +
        (f.lastContactAt ? `, latest ${f.lastContactAt.slice(0, 10)}` : "") + `)` : ""),
    "",
    "DRAFT — prepared for the customer to review and file. Nothing here has been sent to anyone.",
    "",
  ];
}

function claimsSection(f: CaseFacts): string[] {
  if (!f.claims.length) return [];
  const lines = ["FACTS ON RECORD (with provenance):", ""];
  for (const c of f.claims) lines.push(`  - [${c.status.replace(/_/g, " ")}] ${c.text}`);
  lines.push("");
  return lines;
}

function timelineSection(f: CaseFacts): string[] {
  if (!f.outcomes.length) return [];
  const lines = ["OUTCOME TIMELINE (system ledger):", ""];
  for (const o of f.outcomes) lines.push(`  - ${o.at.slice(0, 10)}  ${o.status}: ${o.detail}`);
  lines.push("");
  return lines;
}

function deadlinesSection(f: CaseFacts): string[] {
  if (!f.deadlines.length) return [];
  const lines = ["DEADLINES (source-labeled):", ""];
  for (const d of f.deadlines) {
    lines.push(`  - ${d.kind.replace(/_/g, " ")}: due ${d.dueAt.slice(0, 10)} — ${d.status} (${d.source.replace(/_/g, " ").toLowerCase()})`);
  }
  lines.push("");
  return lines;
}

function evidenceSection(f: CaseFacts): string[] {
  if (!f.evidence.length) return [];
  const lines = ["EVIDENCE EXHIBITS (SHA-256 on file):", ""];
  for (const e of f.evidence) {
    lines.push(`  - ${e.kind}${e.label ? `: ${e.label}` : ""}${e.sha256 ? ` (sha256 ${e.sha256.slice(0, 12)}…)` : ""}`);
  }
  lines.push("");
  return lines;
}

// Which dispute track the letter describes. FCBA covers goods/services not
// delivered or not accepted on a CREDIT card — a 60-day clock from the
// statement that first showed the charge. "Not as described" usually runs on
// card-network chargeback rules. Debit/unknown → card-issuer dispute under
// network rules. Reg E is never cited (it covers EFT errors, not merchant
// refund disputes).
function disputeTrack(f: CaseFacts): { title: string; text: string } {
  const notDelivered = ["missing_item", "incomplete_order", "refund_not_received", "return_refund_pending"].includes(f.issueType);
  if (f.cardType === "credit" && notDelivered) {
    return {
      title: "Applicable framework: Fair Credit Billing Act (billing error — credit card)",
      text:
        "This charge appears to qualify as a billing error under the Fair Credit Billing Act " +
        "(goods/services not delivered or not accepted). The customer has 60 days from the date of the " +
        "card statement that first showed the charge to dispute it in writing. " +
        (f.statementDate
          ? `The statement date provided by the customer is ${f.statementDate} (customer-stated).`
          : "The statement date should be filled in by the customer before filing."),
    };
  }
  if (f.cardType === "credit") {
    return {
      title: "Applicable framework: card-network chargeback rules (not as described)",
      text:
        "This dispute is a 'not as described / services issue' claim, which typically proceeds under the " +
        "card network's chargeback rules rather than the FCBA. The card issuer will determine the correct track.",
    };
  }
  return {
    title: "Applicable framework: card-issuer dispute (network rules)",
    text:
      "The customer paid by debit card or the card type was not specified. This dispute proceeds as a " +
      "card-issuer dispute under the applicable card network's rules; the issuer will determine the framework. " +
      "(No Regulation E citation is made: Reg E covers electronic funds transfer errors, not merchant refund disputes.)",
  };
}

export function renderChargebackDraft(f: CaseFacts): string {
  const track = disputeTrack(f);
  const lines = [
    ...header(f, "CARD DISPUTE LETTER — DRAFT FOR CUSTOMER TO FILE"),
    "To: the card-issuing bank's billing disputes department",
    "From: the cardholder (customer of record)",
    "",
    "I am writing to dispute the charge identified above.",
    "",
    track.title,
    track.text,
    "",
    ...claimsSection(f),
    ...timelineSection(f),
    ...deadlinesSection(f),
    "ATTEMPTS TO RESOLVE WITH THE MERCHANT:",
    "",
    `  The merchant was contacted ${f.contactCount} time(s)` +
      (f.firstContactAt ? ` between ${f.firstContactAt.slice(0, 10)} and ${(f.lastContactAt ?? f.firstContactAt).slice(0, 10)}` : "") +
      ` through its support channels. Escalation reached step ${f.maxRung} of the documented escalation process.`,
    "",
    ...evidenceSection(f),
    "REQUEST: Please investigate and return the disputed amount to my account.",
    "",
    "Helpful official guidance:",
    "  - https://www.consumerfinance.gov/ask-cfpb/how-do-i-dispute-a-charge-on-my-credit-card-bill-en-32/",
    "  - https://consumer.ftc.gov/articles/using-credit-cards-and-disputing-charges",
    "",
    NOT_LEGAL_ADVICE,
  ];
  return lines.join("\n");
}

export interface ComplaintDraft {
  agency: string;
  url: string;
  body: string;
}

const FINANCIAL_ISSUE_TYPES = new Set<string>([
  // V1 ISSUE_TYPES are all retail post-purchase — CFPB stays gated off unless a
  // future financial-product issue type is added and explicitly listed here.
]);

export function renderComplaintDrafts(f: CaseFacts): ComplaintDraft[] {
  const shared = [
    `Merchant: ${f.company}`,
    ...(f.orderRef ? [`Order reference: ${f.orderRef}`] : []),
    `Amount in dispute: ${money(f)}`,
    `Issue: ${f.issueType.replace(/_/g, " ")} — requested ${f.desiredOutcome}.`,
    "",
    "Summary of facts:",
    ...f.claims.map((c) => `  - ${c.text}`),
    "",
    `Contact history: the merchant was contacted ${f.contactCount} time(s)` +
      (f.firstContactAt ? ` (first ${f.firstContactAt.slice(0, 10)}, latest ${(f.lastContactAt ?? f.firstContactAt).slice(0, 10)})` : "") +
      `; escalation reached step ${f.maxRung}.`,
    "",
    `Requested resolution: ${f.desiredOutcome}.`,
    "",
    NOT_LEGAL_ADVICE,
  ].join("\n");

  const drafts: ComplaintDraft[] = [
    {
      agency: "FTC ReportFraud",
      url: "https://reportfraud.ftc.gov/",
      body: [`Complaint to the Federal Trade Commission`, ``, ...shared.split("\n")].join("\n"),
    },
    {
      agency: "State Attorney General — consumer protection",
      url: "https://www.naag.org/find-my-ag/",
      body: [`Consumer-protection complaint to the customer's state Attorney General`, ``, ...shared.split("\n")].join("\n"),
    },
    {
      agency: "Better Business Bureau",
      url: "https://www.bbb.org/file-a-complaint",
      body: [`Complaint to the Better Business Bureau`, ``, ...shared.split("\n")].join("\n"),
    },
  ];
  // CFPB is correct only for financial-product issues — never retail cases.
  if (FINANCIAL_ISSUE_TYPES.has(f.issueType)) {
    drafts.unshift({
      agency: "Consumer Financial Protection Bureau",
      url: "https://www.consumerfinance.gov/complaint/",
      body: [`Complaint to the CFPB`, ``, ...shared.split("\n")].join("\n"),
    });
  }
  return drafts;
}

// The evidence bundle is a verbatim RECORD (timeline + transcript metadata +
// claims w/ provenance + evidence hashes) — it is the exhibit, not a letter,
// so merchant-authored records appear here labeled, verbatim, as the record
// of what happened.
export function renderBundleLines(
  f: CaseFacts,
  messages: { direction: string; channel: string; subject: string; body: string; at: string }[],
): string[] {
  const lines = [
    ...header(f, `EVIDENCE BUNDLE — CASE ${f.caseId}`),
    "Generated by Company Service from stored case records. Message bodies are",
    "verbatim excerpts (records of what each party wrote), labeled by direction.",
    "",
    ...claimsSection(f),
    ...timelineSection(f),
    ...deadlinesSection(f),
    "MESSAGE LOG:",
    "",
  ];
  for (const m of messages) {
    lines.push(`  ${m.at.slice(0, 16).replace("T", " ")}Z  ${m.direction === "out" ? "customer's agent → merchant" : "merchant → customer's agent"}  [${m.channel}]`);
    if (m.subject) lines.push(`    subject: ${m.subject}`);
    for (const bline of m.body.slice(0, 500).split("\n")) lines.push(`    ${bline}`);
    if (m.body.length > 500) lines.push(`    … (${m.body.length - 500} more chars)`);
    lines.push("");
  }
  lines.push("", ...evidenceSection(f));
  return lines;
}
