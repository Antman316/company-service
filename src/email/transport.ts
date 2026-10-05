import { q1 } from "../core/db";
import { decryptJson } from "../security/crypto";
import { TEST_MERCHANT_EMAIL } from "../adapters/testMerchant";

// ---------------------------------------------------------------------------
// Outbound email transports — chosen in strict order:
//   1. test-merchant domain  -> internal simulation (DEMO, no mail leaves)
//   2. active gmail connection (customer BYO OAuth, send-only gmail.send scope)
//   3. Resend send-only API key (env.RESEND_API_KEY) -> real delivery
//   4. dev_log (records intent, marks simulated — no real mail)
// The customer's Gmail is only ever used to SEND — we never read their inbox.
// Inbound replies land on env.INBOUND_ADDRESS via Cloudflare Email Routing.
// ---------------------------------------------------------------------------

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

// Route an outbound case email through the right transport.
export async function sendCaseEmail(
  env: Env,
  userId: string,
  msg: OutboundEmail,
): Promise<SendResult> {
  const domain = msg.to.split("@")[1]?.toLowerCase() ?? "";
  if (msg.to.toLowerCase() === TEST_MERCHANT_EMAIL || domain === "test-merchant.demo") {
    return { ok: true, transport: "sim_email", externalId: `sim-${Date.now()}`, simulated: true };
  }

  const conn = await q1<{ config_enc: string | null }>(
    env.DB,
    `SELECT config_enc FROM connections WHERE user_id = ? AND type = 'email' AND provider = 'gmail' AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    userId,
  );
  if (conn?.config_enc && env.SECRET_KEY) {
    const cfg = await decryptJson<GmailCfg>(conn.config_enc, env.SECRET_KEY);
    return gmailSend(cfg, msg);
  }

  const resConn = await q1<{ config_enc: string | null }>(
    env.DB,
    `SELECT config_enc FROM connections WHERE user_id = ? AND type = 'email' AND provider = 'resend' AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    userId,
  );
  if (resConn?.config_enc && env.SECRET_KEY) {
    const cfg = await decryptJson<ResendCfg>(resConn.config_enc, env.SECRET_KEY);
    return resendSend({ ...cfg, from: cfg.from ?? env.EMAIL_FROM }, msg);
  }
  if (env.RESEND_API_KEY) {
    return resendSend(
      { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM ?? `Company Service <${env.INBOUND_ADDRESS ?? "cases@agentmasterkey.com"}>` },
      msg,
    );
  }

  // Dev transport: no real email leaves the system. Honest labeling.
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
      : env.RESEND_API_KEY
        ? `resend send-only key (${env.EMAIL_FROM ?? "cases@agentmasterkey.com"})`
        : "dev_log (no live delivery)",
    inbound,
    configured: !!conn || !!env.RESEND_API_KEY,
  };
}
