import { newId, q1, run } from "./db";

// ---------------------------------------------------------------------------
// §11 abuse & fraud controls (M7). Two surfaces:
//   1. Per-user active-case cap — an unattended agent cannot fan out forever.
//   2. Outbound content checks — everything the agent would say to a merchant
//      (drafted or sent) is screened. Patterns are deliberately narrow: they
//      block what is never legitimate (threats, full card numbers, credential
//      leaks) rather than guessing at fabricated facts, which the customer is
//      ultimately responsible for.
// ---------------------------------------------------------------------------

export const MAX_ACTIVE_CASES_PER_USER = 10;

const TERMINAL_STATUSES = ["RESOLVED", "CANCELLED", "UNRESOLVED", "UNSUPPORTED"];

export async function activeCaseCount(db: D1Database, userId: string): Promise<number> {
  const row = await q1<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM cases WHERE user_id = ? AND status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})`,
    userId,
    ...TERMINAL_STATUSES,
  );
  return row?.n ?? 0;
}

export interface ContentFlag {
  code: "threat" | "sensitive_pan" | "credential_leak" | "harassment";
  match: string;
}

const CONTENT_RULES: { code: ContentFlag["code"]; re: RegExp }[] = [
  // Threats of physical harm / violence / property damage — never legitimate.
  { code: "threat", re: /\b(kill|murder|hurt|harm|attack|bomb|shoot|burn down|destroy)\b[^.\n]{0,40}\b(you|your|u)\b/i },
  { code: "threat", re: /\b(i('ll| will) (find|come|hurt|harm|kill))\b/i },
  // Full card / account numbers must never leave the system in agent text.
  { code: "sensitive_pan", re: /\b(?:\d[ -]?){13,19}\b/ },
  // Credential leaks — never ask the agent to send a password/OTP/SSN.
  { code: "credential_leak", re: /\b(password|passcode|one[- ]?time code|otp|ssn|social security)\s*[:=]\s*\S+/i },
  // Harassment patterns — slurs / demeaning abuse toward support staff.
  { code: "harassment", re: /\b(you('re| are) (an? )?(idiot|moron|stupid|incompetent|worthless)|shut up|screw you)\b/i },
];

export function contentCheck(text: string): { ok: boolean; flags: ContentFlag[] } {
  const flags: ContentFlag[] = [];
  for (const r of CONTENT_RULES) {
    const m = text.match(r.re);
    if (m) flags.push({ code: r.code, match: m[0].slice(0, 80) });
  }
  return { ok: flags.length === 0, flags };
}

export async function recordFraudSignal(
  db: D1Database,
  opts: { userId: string; caseId?: string | null; kind: string; detail?: string },
): Promise<void> {
  await run(
    db,
    `INSERT INTO fraud_signals (id, case_id, user_id, kind, detail) VALUES (?,?,?,?,?)`,
    newId("fs"),
    opts.caseId ?? null,
    opts.userId,
    opts.kind,
    (opts.detail ?? "").slice(0, 500),
  );
}
