import type {
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ProviderHealth,
} from "../core/types";
import { detectInjection } from "../security/injection";

// ---------------------------------------------------------------------------
// LOCAL DETERMINISTIC PROVIDER — development/test provider only.
// Produces structured output with deterministic extraction logic so the full
// product runs with zero external credentials. It is NOT a language model and
// is clearly labeled everywhere as `local_dev`. Real reasoning comes from
// configured providers (OpenAI/Anthropic/compatible) via Connections.
// ---------------------------------------------------------------------------

function task(req: ModelRequest): string {
  const m = req.userContext.match(/^TASK:([a-z_]+)/m);
  return m?.[1] ?? "unknown";
}

function extractJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

const KNOWN_COMPANIES = [
  "amazon", "walmart", "target", "best buy", "ebay", "costco", "apple",
  "samsung", "nike", "adidas", "home depot", "lowes", "ikea", "wayfair",
  "chewy", "newegg", "macys", "nordstrom", "zappos", "shein", "temu",
];

function extractObjective(text: string) {
  const lower = text.toLowerCase();
  const company = KNOWN_COMPANIES.find((c) => lower.includes(c)) ??
    (lower.match(/(?:order|from|with|to)\s+(?:the\s+)?([A-Z][A-Za-z0-9&.' -]{2,25})/)?.[1]?.trim()) ??
    (text.match(/([A-Z][A-Za-z0-9&.'-]{2,25})/)?.[1] ?? "unknown company");
  const amountMatch = text.match(/\$\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/);
  const amountCents = amountMatch ? Math.round(parseFloat(amountMatch[1]!.replace(/,/g, "")) * 100) : null;
  let issueType = "other_post_purchase";
  if (/refund|money back|owe/i.test(text)) issueType = /return/i.test(text) ? "return_refund_pending" : "refund_not_received";
  else if (/wrong item|wrong product|incorrect item/i.test(text)) issueType = "wrong_item";
  else if (/damaged|broken|defective|cracked|shattered/i.test(text)) issueType = "damaged_item";
  else if (/missing|never arrived|didn'?t (get|receive)|lost/i.test(text)) issueType = "missing_item";
  else if (/incomplete|partial order|part of/i.test(text)) issueType = "incomplete_order";
  else if (/status|where is|tracking/i.test(text)) issueType = "order_status";

  const orderMatch = text.match(/\b(?:order\s*#?\s*|order\s+number\s*)([A-Z0-9-]{5,})/i);
  const trackingMatch = text.match(/\b(1Z[A-Z0-9]{16}|\b\d{12,}\b)\b/);

  const claims: { text: string; kind: string }[] = [];
  claims.push({ text: `Customer reports issue with ${company}`, kind: "statement" });
  if (amountCents != null) claims.push({ text: `Amount at issue: $${(amountCents / 100).toFixed(2)}`, kind: "statement" });
  if (/return/i.test(text)) claims.push({ text: "Item was returned (per customer statement)", kind: "statement" });
  if (orderMatch) claims.push({ text: `Order reference: ${orderMatch[1]}`, kind: "order_info" });
  if (trackingMatch) claims.push({ text: `Tracking number: ${trackingMatch[1]}`, kind: "tracking" });

  const missing: string[] = [];
  if (!orderMatch) missing.push("order_number");
  if (amountCents == null && (issueType === "refund_not_received" || issueType === "return_refund_pending")) {
    missing.push("refund_amount");
  }
  if (issueType === "return_refund_pending" && !trackingMatch) missing.push("return_tracking");

  return {
    company,
    issueType,
    desiredOutcome: amountCents != null
      ? `Full refund of $${(amountCents / 100).toFixed(2)}`
      : "Resolution per customer request",
    amountCents,
    currency: "USD",
    orderRef: orderMatch?.[1] ?? null,
    trackingRef: trackingMatch?.[1] ?? null,
    missingInfo: missing,
    claims,
  };
}

function analyzeMerchant(text: string) {
  const inj = detectInjection(text);
  const lower = text.toLowerCase();
  const amountMatch = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  const amountCents = amountMatch ? Math.round(parseFloat(amountMatch[1]!) * 100) : null;
  const daysMatch = text.match(/(\d+)\s*(?:-\s*\d+\s*)?(?:business\s+)?days?/i);

  let intent: string = "other";
  if (/\bdenied|cannot (issue|offer)|not eligible|rejected\b/.test(lower)) intent = "denial";
  else if (/store credit|gift card/.test(lower)) intent = "offer";
  else if (/replacement|exchange/.test(lower)) intent = "offer";
  else if (/partial refund|offer you|we can offer/.test(lower)) intent = "offer";
  else if (/refund.*(issued|processed|complete|sent)/.test(lower)) intent = "resolution";
  else if (/refund.*(approved|will|should|expect|within|process)/.test(lower)) intent = "promise";
  else if (/need|send (us |)your|provide|photo|receipt|evidence|proof/.test(lower)) intent = "evidence_request";
  else if (/escalat|supervisor|manager|specialist/.test(lower)) intent = "escalation";
  else if (/receiv|got your|thank you for (contacting|reaching)|we('ll| will) (review|look)/.test(lower)) intent = "acknowledgment";

  return {
    intent,
    amountCents,
    promiseDays: daysMatch ? parseInt(daysMatch[1]!, 10) : null,
    offerKind: /store credit|gift card/.test(lower) ? "store_credit" : /replacement|exchange/.test(lower) ? "replacement" : amountCents != null ? "money" : null,
    injectionDetected: inj.detected,
    injectionMatches: inj.matches,
    summary: text.slice(0, 280),
  };
}

function composeMessage(ctx: string): string {
  // Extract fields the caller embedded as KEY=value lines.
  const field = (k: string) => ctx.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  const company = field("COMPANY") || "the company";
  const objective = field("OBJECTIVE") || "resolve this issue";
  const orderRef = field("ORDER_REF");
  const tracking = field("TRACKING");
  const purpose = field("PURPOSE") || "initial";
  const customer = field("CUSTOMER") || "the customer";

  const lines: string[] = [];
  if (purpose === "followup") {
    lines.push(`Hello ${company} support,`, ``);
    lines.push(`I am following up on this case. ${objective}.`);
    lines.push(`Your team previously indicated this would be handled. Could you confirm the current status and expected resolution date?`);
  } else if (purpose === "escalation") {
    lines.push(`Hello ${company} support,`, ``);
    lines.push(`I need to escalate this matter. ${objective}.`);
    lines.push(`This has not been resolved within the expected timeframe. Please connect me with a supervisor or the appropriate escalation team.`);
  } else {
    lines.push(`Hello ${company} support,`, ``);
    lines.push(`I am writing on behalf of ${customer} regarding an order issue.`);
    lines.push(`Requested resolution: ${objective}.`);
    if (orderRef) lines.push(`Order reference: ${orderRef}.`);
    if (tracking) lines.push(`Return tracking number: ${tracking}.`);
    lines.push(`Please confirm receipt of this message and advise on next steps.`);
  }
  lines.push(``, `Thank you.`, `(Sent by Company Service — an AI representative authorized by ${customer}.)`);
  return lines.join("\n");
}

function plan(ctx: string) {
  const steps = [
    { kind: "send_message", reason: "open contact with merchant via supported channel" },
    { kind: "request_refund_status", reason: "ask for refund status / outcome" },
    { kind: "send_followup", reason: "durably follow up if commitment unfulfilled" },
  ];
  return { steps };
}

export function localDevProvider(): ModelProvider {
  return {
    id: "local_dev",
    async capabilities(): Promise<ModelCapabilities> {
      return { roles: ["light", "reasoning"], structuredOutput: true, vision: false, liveVerified: false };
    },
    async healthCheck(): Promise<ProviderHealth> {
      return { ok: true, detail: "deterministic local provider (no external calls)", checkedAt: new Date().toISOString() };
    },
    async execute(req: ModelRequest): Promise<ModelResponse> {
      const t = task(req);
      const untrusted = req.untrustedContent ?? "";
      const ctx = req.userContext + "\n" + untrusted;
      let out: unknown;
      switch (t) {
        case "extract_objective":
          out = extractObjective(req.userContext.replace(/^TASK:extract_objective\n?/, ""));
          break;
        case "analyze_merchant":
          out = analyzeMerchant(untrusted);
          break;
        case "compose":
          out = { body: composeMessage(ctx) };
          break;
        case "plan":
          out = plan(ctx);
          break;
        default:
          out = { text: "local_dev provider: unsupported task", echo: req.userContext.slice(0, 400) };
      }
      return {
        providerId: "local_dev",
        model: "local-deterministic-v1",
        text: typeof out === "string" ? out : JSON.stringify(out),
        tokensIn: Math.ceil(ctx.length / 4),
        tokensOut: Math.ceil(JSON.stringify(out).length / 4),
        costMicroUsd: 0,
      };
    },
  };
}

export { extractJsonSafe };
