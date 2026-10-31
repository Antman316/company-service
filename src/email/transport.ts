import { q1 } from "../core/db";
import { decryptJson } from "../security/crypto";
import { TEST_MERCHANT_EMAIL } from "../adapters/testMerchant";
import {
  DISCLOSURE_REJECTION,
  hasDisclosedAssistance,
  orgKeySendDecision,
  verifySendBinding,
  type SendApprovalBinding,
} from "./sendSafety";

// ---------------------------------------------------------------------------
// Outbound case email — customer route only.
//   1. test-merchant domain  -> internal simulation (DEMO, no mail leaves)
//   2. disclosed-assistance line required, then per-send approval binding
//   3. active gmail connection (customer BYO OAuth, send-only gmail.send scope)
//   4. active resend connection (customer's own send-only key)
//   5. organization keys (env.MAILOUT / env.RESEND_API_KEY) are NOT a fallback.
//      If one is configured and the customer has no route, the send fails closed.
//   6. dev_log only when no customer route and no organization key is configured
// The customer's Gmail is only ever used to SEND — we never read their inbox.
// Inbound replies land on env.INBOUND_ADDRESS via Cloudflare Email Routing.
// System mail to the customer (verify/reset/notify) is a separate path.
// ---------------------------------------------------------------------------

export interface SendGate {
  binding: SendApprovalBinding | null;
  mandateVersion: number;
  /** Claim the approval for this attempt. False means it was already used. */
  consume?: () => Promise<boolean>;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
  /** RFC Message-ID we stamp so merchant replies thread via In-Reply-To. */
  messageId?: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  transport: string;
  externalId?: string;
  error?: string;
  simulated?: boolean;
}

interface GmailCfg {
  accessToken?: string;
  from?: string;
}

async function gmailSend(cfg: GmailCfg, msg: OutboundEmail): Promise<SendResult> {
  if (!cfg.accessToken || !cfg.from) {
    return { ok: false, transport: "gmail", error: "missing access token or from address" };
  }
  if (!hasDisclosedAssistance(msg.body)) {
    return { ok: false, transport: "gmail", error: DISCLOSURE_REJECTION };
  }
  const mime = [
    `From: ${cfg.from}`,
    `To: ${msg.to}`,
    `Subject: ${msg.subject}`,
    msg.replyTo ? `Reply-To: ${msg.replyTo}` : "",
    msg.messageId ? `Message-ID: <${msg.messageId}>` : "",
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    msg.body,
  ].filter(Boolean).join("\r\n");
  const raw = btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!r.ok) return { ok: false, transport: "gmail", error: `gmail API ${r.status}: ${await r.text()}` };
    const data = (await r.json()) as { id?: string };
    return { ok: true, transport: "gmail", externalId: data.id };
  } catch (e) {
    return { ok: false, transport: "gmail", error: String(e) };
  }
}

interface ResendCfg {
  apiKey?: string;
  from?: string;
}

// Resend send-only transport. Minimal permission: the API key can only send
// for the verified domain — no mailbox read exists to grant or abuse.
async function resendSend(cfg: ResendCfg, msg: OutboundEmail): Promise<SendResult> {
  if (!cfg.apiKey || !cfg.from) {
    return { ok: false, transport: "resend", error: "missing api key or from address" };
  }
  if (!hasDisclosedAssistance(msg.body)) {
    return { ok: false, transport: "resend", error: DISCLOSURE_REJECTION };
  }
  const headers: Record<string, string> = { ...(msg.headers ?? {}) };
  if (msg.messageId) headers["Message-ID"] = `<${msg.messageId}>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: cfg.from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.body,
        reply_to: msg.replyTo ? [msg.replyTo] : undefined,
        headers: Object.keys(headers).length ? headers : undefined,
      }),
    });
    if (!r.ok) return { ok: false, transport: "resend", error: `resend API ${r.status}: ${await r.text()}` };
    const data = (await r.json()) as { id?: string };
    return { ok: true, transport: "resend", externalId: data.id };
  } catch (e) {
    return { ok: false, transport: "resend", error: String(e) };
  }
}

// Cloudflare-native transport: the Email Routing `send_email` binding on the
// same zone. Zero external credentials — sends through the zone's real SMTP
// path with managed DKIM/SPF. Minimal permission by construction.
async function cloudflareSend(env: Env, msg: OutboundEmail): Promise<SendResult> {
  if (!env.MAILOUT) {
    return { ok: false, transport: "cloudflare_send_email", error: "MAILOUT binding not configured" };
  }
  if (!hasDisclosedAssistance(msg.body)) {
    return { ok: false, transport: "cloudflare_send_email", error: DISCLOSURE_REJECTION };
  }
  const fromAddr = env.INBOUND_ADDRESS ?? "cases@agentmasterkey.com";
  const raw = [
    `From: ${env.EMAIL_FROM ?? `Company Service <${fromAddr}>`}`,
    `To: ${msg.to}`,
    `Subject: ${msg.subject}`,
    msg.replyTo ? `Reply-To: ${msg.replyTo}` : "",
    msg.messageId ? `Message-ID: <${msg.messageId}>` : "",
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    msg.body,
  ].filter(Boolean).join("\r\n");
  try {
    const { EmailMessage } = await import("cloudflare:email");
    await env.MAILOUT.send(new EmailMessage(fromAddr, msg.to, raw));
    return {
      ok: true,
      transport: "cloudflare_send_email",
      externalId: msg.messageId ? `<${msg.messageId}>` : undefined,
    };
  } catch (e) {
    return { ok: false, transport: "cloudflare_send_email", error: String(e) };
  }
}

// Route an outbound case email. Organization keys are never a silent fallback.
export async function sendCaseEmail(
  env: Env,
  userId: string,
  msg: OutboundEmail,
  gate?: SendGate,
): Promise<SendResult> {
  const domain = msg.to.split("@")[1]?.toLowerCase() ?? "";
  if (msg.to.toLowerCase() === TEST_MERCHANT_EMAIL || domain === "test-merchant.demo") {
    return { ok: true, transport: "sim_email", externalId: `sim-${Date.now()}`, simulated: true };
  }

  if (!hasDisclosedAssistance(msg.body)) {
    return { ok: false, transport: "blocked", error: DISCLOSURE_REJECTION };
  }

  const verified = await verifySendBinding({
    binding: gate?.binding,
    body: msg.body,
    recipient: msg.to,
    mandateVersion: gate?.mandateVersion ?? Number.NaN,
  });
  if (!verified.ok) {
    return { ok: false, transport: "blocked", error: verified.error };
  }

  const conn = await q1<{ config_enc: string | null }>(
    env.DB,
    `SELECT config_enc FROM connections WHERE user_id = ? AND type = 'email' AND provider = 'gmail' AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    userId,
  );
  const resConn = await q1<{ config_enc: string | null }>(
    env.DB,
    `SELECT config_enc FROM connections WHERE user_id = ? AND type = 'email' AND provider = 'resend' AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    userId,
  );
  const hasCustomerRoute = Boolean(
    (conn?.config_enc && env.SECRET_KEY) || (resConn?.config_enc && env.SECRET_KEY),
  );
  const orgDecision = orgKeySendDecision({
    hasCustomerRoute,
    orgKeyAvailable: Boolean(env.MAILOUT || env.RESEND_API_KEY),
  });
  if (!orgDecision.ok) {
    return { ok: false, transport: "org_key_blocked", error: orgDecision.error };
  }

  if (gate?.consume) {
    const claimed = await gate.consume();
    if (!claimed) {
      return { ok: false, transport: "blocked", error: "send rejected: approval already used" };
    }
  }

  if (conn?.config_enc && env.SECRET_KEY) {
    const cfg = await decryptJson<GmailCfg>(conn.config_enc, env.SECRET_KEY);
    return gmailSend(cfg, msg);
  }

  if (resConn?.config_enc && env.SECRET_KEY) {
    const cfg = await decryptJson<ResendCfg>(resConn.config_enc, env.SECRET_KEY);
    return resendSend({ ...cfg, from: cfg.from ?? env.EMAIL_FROM }, msg);
  }

  // No customer route and no organization key: record intent only. Honest labeling.
  console.log(`[dev-email] to=${msg.to} subject=${msg.subject}`);
  return { ok: true, transport: "dev_log", externalId: `dev-${Date.now()}`, simulated: true };
}

// What the configured email path can currently do — surfaced in Connections UI
// so we never pretend an inbox-less setup can receive replies everywhere.
export async function emailCapability(env: Env, userId: string) {
  const conn = await q1<{ provider: string; status: string }>(
    env.DB,
    `SELECT provider, status FROM connections WHERE user_id = ? AND type = 'email' AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    userId,
  );
  const inbound = env.INBOUND_ADDRESS
    ? `${env.INBOUND_ADDRESS} via Cloudflare Email Routing -> email() handler (live)`
    : "case+<id>@configured-domain via Cloudflare Email Routing (requires domain setup)";
  return {
    outbound: conn
      ? `${conn.provider} via customer connection (send-only scope)`
      : "not configured — a customer send route is required; organization keys are not a fallback",
    inbound,
    configured: !!conn,
  };
}
