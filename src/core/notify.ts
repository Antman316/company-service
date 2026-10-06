import { auditEvent, caseEvent } from "./events";
import { newId, q1, run, sha256Hex } from "./db";

// ---------------------------------------------------------------------------
// Customer notifications + system email (M7). Every outbound system email is
// audited; a customer can switch each kind off from the preferences page.
// The transport is deliberately NOT the customer's case connection — verify /
// reset / notification mail always comes from us (MAILOUT -> resend -> dev_log).
// ---------------------------------------------------------------------------

export type NotificationKind =
  | "merchant_replied"
  | "approval_needed"
  | "deadline_approaching"
  | "money_checkin"
  | "case_resolved";

export const NOTIFICATION_KINDS: NotificationKind[] = [
  "merchant_replied",
  "approval_needed",
  "deadline_approaching",
  "money_checkin",
  "case_resolved",
];

// System email transport — never the customer's own provider connection.
export async function sendSystemEmail(
  env: Env,
  to: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; transport: string; error?: string }> {
  const fromAddr = env.INBOUND_ADDRESS ?? "cases@agentmasterkey.com";
  const from = env.EMAIL_FROM ?? `Company Service <${fromAddr}>`;
  if (env.MAILOUT) {
    try {
      const { EmailMessage } = await import("cloudflare:email");
      const raw = [
        `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
        `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8`, ``, body,
      ].join("\r\n");
      await env.MAILOUT.send(new EmailMessage(fromAddr, to, raw));
      return { ok: true, transport: "cloudflare_send_email" };
    } catch (e) {
      return { ok: false, transport: "cloudflare_send_email", error: String(e) };
    }
  }
  if (env.RESEND_API_KEY) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text: body }),
      });
      if (!r.ok) return { ok: false, transport: "resend", error: `resend API ${r.status}` };
      return { ok: true, transport: "resend" };
    } catch (e) {
      return { ok: false, transport: "resend", error: String(e) };
    }
  }
  console.log(`[dev-email] to=${to} subject=${subject}`);
  return { ok: true, transport: "dev_log" };
}

export async function notify(
  env: Env,
  userId: string,
  kind: NotificationKind,
  msg: { subject: string; body: string; caseId?: string },
): Promise<void> {
  const pref = await q1<{ enabled: number }>(
    env.DB,
    `SELECT enabled FROM notification_prefs WHERE user_id = ? AND kind = ?`,
    userId,
    kind,
  );
  // Default is ON — a row only exists after the customer changes it.
  if (pref && !pref.enabled) {
    await auditEvent(env.DB, {
      type: "notification_suppressed", severity: "info",
      userId, caseId: msg.caseId ?? null,
      data: { kind },
    });
    return;
  }
  const user = await q1<{ email: string }>(env.DB, `SELECT email FROM users WHERE id = ?`, userId);
  if (!user) return;
  const sent = await sendSystemEmail(env, user.email, msg.subject, msg.body);
  await auditEvent(env.DB, {
    type: "notification_sent", severity: sent.ok ? "info" : "warning",
    userId, caseId: msg.caseId ?? null,
    data: { kind, transport: sent.transport, ok: sent.ok, error: sent.error ?? null },
  });
}

// ---------------------------------------------------------------------------
// One-shot user tokens (email verification + TOTP challenges). Raw token is
// returned once and only ever stored as a sha256.
// ---------------------------------------------------------------------------

export async function issueUserToken(
  db: D1Database,
  userId: string,
  kind: string,
  ttlMs: number,
  payload?: Record<string, unknown>,
): Promise<string> {
  const token = `cs_${kind.slice(0, 3)}_${newId("tok")}${newId("tok")}`;
  await run(
    db,
    `INSERT INTO user_tokens (id, user_id, kind, token_hash, payload_json, expires_at) VALUES (?,?,?,?,?,?)`,
    newId("ut"),
    userId,
    kind,
    await sha256Hex(token),
    payload ? JSON.stringify(payload) : null,
    new Date(Date.now() + ttlMs).toISOString(),
  );
  return token;
}

export async function consumeUserToken(
  db: D1Database,
  token: string,
  kind: string,
): Promise<{ userId: string; payload: Record<string, unknown> } | null> {
  const row = await q1<{ id: string; user_id: string; payload_json: string | null; expires_at: string; used_at: string | null }>(
    db,
    `SELECT id, user_id, payload_json, expires_at, used_at FROM user_tokens WHERE token_hash = ? AND kind = ?`,
    await sha256Hex(token),
    kind,
  );
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  await run(db, `UPDATE user_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, row.id);
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.payload_json ?? "{}"); } catch { /* ignore */ }
  return { userId: row.user_id, payload };
}

export async function countRecentTokens(db: D1Database, userId: string, kind: string, windowMs: number): Promise<number> {
  const row = await q1<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM user_tokens WHERE user_id = ? AND kind = ? AND created_at >= ?`,
    userId,
    kind,
    new Date(Date.now() - windowMs).toISOString(),
  );
  return row?.n ?? 0;
}

// Email verification: the link is one-shot. In non-production environments the
// raw token is also written to the audit trail so staging/dev smoke tests can
// complete the flow without a working mailbox — never in prod.
export async function sendVerificationEmail(env: Env, userId: string, email: string): Promise<void> {
  const token = await issueUserToken(env.DB, userId, "email_verify", 24 * 3600 * 1000);
  const origin = env.APP_ORIGIN ?? `https://${env.EMAIL_DOMAIN ?? "agentmasterkey.com"}`;
  const link = `${origin}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const sent = await sendSystemEmail(
    env,
    email,
    "Verify your Company Service email",
    `Confirm this email address to let your agent act for you.\n\n${link}\n\nThe link works once and expires in 24 hours. If you didn't sign up, ignore this — nothing will happen.`,
  );
  await auditEvent(env.DB, {
    type: "email_verification_sent", severity: sent.ok ? "info" : "warning",
    userId,
    data: {
      transport: sent.transport, ok: sent.ok,
      ...(env.ENVIRONMENT !== "production" ? { devToken: token } : {}),
    },
  });
}
