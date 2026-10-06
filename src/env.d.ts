// Augment the generated Env with bindings that are provisioned outside
// wrangler.jsonc vars (secrets) or that tests mock.
interface Env {
  /** Cloudflare secret used to encrypt connection credentials at rest. */
  SECRET_KEY?: string;
  /** Resend send-only API key — org-level outbound transport (secret). */
  RESEND_API_KEY?: string;
  /** The mailbox inbound case mail lands on, e.g. cases@agentmasterkey.com. */
  INBOUND_ADDRESS?: string;
  /** Outbound From header, e.g. "Company Service <cases@agentmasterkey.com>". */
  EMAIL_FROM?: string;
  /** Cloudflare Email Routing send_email binding — native outbound lane. */
  MAILOUT?: SendEmailBinding;
  /** Comma-separated owner emails for /api/admin/results (plain_text var). */
  ADMIN_EMAILS?: string;
}

// Minimal local declaration — full types live in the runtime.
declare module "cloudflare:email" {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string | ReadableStream | ArrayBuffer);
  }
}

interface SendEmailBinding {
  send(message: unknown): Promise<void>;
}
