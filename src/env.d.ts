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
  /** Comma-separated owner emails for /api/admin/results + spend-cap alerts (plain_text var). */
  ADMIN_EMAILS?: string;
  /** Public app origin for links in system emails (defaults to EMAIL_DOMAIN). */
  APP_ORIGIN?: string;
  /** Turnstile site key (public) + secret (worker secret) for signup abuse gate. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** §11 spend caps in micro-USD (plain_text ints; defaults $0.50/$5/$100). */
  CASE_SPEND_CAP_MICRO_USD?: string;
  USER_DAILY_SPEND_CAP_MICRO_USD?: string;
  GLOBAL_DAILY_SPEND_CAP_MICRO_USD?: string;
  /** M9: inbound-burst queue producer (queue consumer = queue() handler). */
  INBOUND_Q?: Queue<import("./core/ops").InboundQueueMessage>;
  /** M9: durable per-follow-up workflow (CaseWorkflow); cron sweep is the backstop. */
  CASE_WORKFLOW?: Workflow<{ followUpId: string; caseId: string }>;
  /** M9 ops alerts recipient (defaults to admin@agentmasterkey.com). */
  OPS_ALERT_EMAIL?: string;
  /** M9 backup retention in days (default 30). */
  BACKUP_RETENTION_DAYS?: string;
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
