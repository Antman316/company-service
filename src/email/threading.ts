import { q1 } from "../core/db";

// Case threading: merchant replies route back to the right case through three
// anchors, checked in order:
//   1. To-address token   case+<token>@<domain>   (per-case literal routes)
//   2. Subject tag        [CS-<token>]            (primary — always stamped)
//   3. References/In-Reply-To vs recorded outbound message-ids (fallback for
//      merchants that rewrite subjects)
//
// V1 uses ONE inbound mailbox (env.INBOUND_ADDRESS, e.g.
// cases@agentmasterkey.com) with a single literal Email Routing rule -> worker.
// Per-case addresses stay supported for future dedicated routes.

export function caseEmailToken(caseId: string): string {
  return caseId.replace(/^case_/, "").slice(0, 12);
}

export function caseAddress(caseId: string, domain: string): string {
  return `case+${caseEmailToken(caseId)}@${domain}`;
}

export function subjectTag(caseId: string): string {
  return `[CS-${caseEmailToken(caseId)}]`;
}

// Extract every <message-id>-looking token from References/In-Reply-To values.
export function extractMessageIds(values: (string | undefined | string[])[]): string[] {
  const ids: string[] = [];
  for (const v of values) {
    const arr = Array.isArray(v) ? v : v ? [v] : [];
    for (const item of arr) {
      for (const m of item.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)) ids.push(m[1]!);
    }
  }
  return [...new Set(ids)];
}

// Resolve the case an inbound email belongs to.
export async function resolveInboundCase(
  db: D1Database,
  msg: {
    to: string;
    subject?: string;
    headers?: Record<string, string>;
    /** All candidate message-ids from Message-ID / In-Reply-To / References. */
    messageIds?: string[];
  },
): Promise<string | null> {
  const to = (msg.to ?? "").toLowerCase();
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
  // Threading fallback: the reply quotes one of our outbound message-ids.
  for (const mid of msg.messageIds ?? []) {
    const row = await q1<{ conversation_id: string }>(
      db,
      `SELECT conversation_id FROM external_messages WHERE external_id = ? LIMIT 1`,
      mid,
    );
    if (row) {
      const conv = await q1<{ case_id: string }>(
        db,
        `SELECT case_id FROM external_conversations WHERE id = ?`,
        row.conversation_id,
      );
      if (conv) return conv.case_id;
    }
  }
  return null;
}

// Minimal RFC822-ish parse good enough for tests + simple messages. The real
// Email Routing path uses postal-mime (proper MIME decode) in index.ts.
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
