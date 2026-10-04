import { q1 } from "../core/db";

// Case threading: every case gets a stable address + subject tag so merchant
// replies route back to the right case regardless of header quirks.
//
// Address form:  case+<token>@<EMAIL_DOMAIN>
// Subject tag:   [CS-<token>]

export function caseEmailToken(caseId: string): string {
  return caseId.replace(/^case_/, "").slice(0, 12);
}

export function caseAddress(caseId: string, domain: string): string {
  return `case+${caseEmailToken(caseId)}@${domain}`;
}

export function subjectTag(caseId: string): string {
  return `[CS-${caseEmailToken(caseId)}]`;
}

// Resolve the case an inbound email belongs to. Checks To: token first, then
// Subject tag, then References/In-Reply-To headers we stamped.
export async function resolveInboundCase(
  db: D1Database,
  msg: { to: string; subject?: string; headers?: Record<string, string> },
): Promise<string | null> {
  const to = msg.to.toLowerCase();
  const addrMatch = to.match(/case\+([0-9a-z]+)@/);
  if (addrMatch?.[1]) {
    const row = await q1<{ id: string }>(
      db,
      `SELECT id FROM cases WHERE replace(id, 'case_', '') LIKE ? LIMIT 1`,
      `${addrMatch[1]}%`,
    );
    if (row) return row.id;
  }
  const subjMatch = (msg.subject ?? "").match(/\[CS-([0-9a-z]+)\]/i);
  if (subjMatch?.[1]) {
    const row = await q1<{ id: string }>(
      db,
      `SELECT id FROM cases WHERE replace(id, 'case_', '') LIKE ? LIMIT 1`,
      `${subjMatch[1].toLowerCase()}%`,
    );
    if (row) return row.id;
  }
  return null;
}

// Minimal RFC822-ish parse good enough for Email Routing handler + tests.
export function parseInbound(raw: string): {
  to: string;
  from: string;
  subject: string;
  body: string;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const splitAt = raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  const head = splitAt >= 0 ? raw.slice(0, splitAt) : raw;
  const body = splitAt >= 0 ? raw.slice(splitAt).replace(/^(\r?\n){1,2}/, "") : "";
  // Unfold continuation lines.
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return {
    to: headers["to"] ?? "",
    from: headers["from"] ?? "",
    subject: headers["subject"] ?? "",
    body,
    headers,
  };
}
