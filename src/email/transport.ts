import { q1 } from "../core/db";
import { decryptJson } from "../security/crypto";
import { TEST_MERCHANT_EMAIL } from "../adapters/testMerchant";

// ---------------------------------------------------------------------------
// Outbound email transports.
// V1 minimum-permission design: the customer's Gmail account is used only to
// SEND (scope: gmail.send) — we never read their inbox. Inbound replies land on
// a case-specific address (Cloudflare Email Routing -> email() handler), so no
// broad mailbox access is required.
// ---------------------------------------------------------------------------

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
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

// Route an outbound case email through the right transport:
//  - test merchant domain -> internal simulation (DEMO)
//  - active gmail connection -> gmail.send
//  - otherwise -> dev log transport (records the message, marks it simulated)
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
  return {
    outbound: conn ? "gmail.send via customer OAuth (send-only scope)" : "dev_log (no live delivery)",
    inbound: "case+<id>@configured-domain via Cloudflare Email Routing (requires domain setup)",
    configured: !!conn,
  };
}
