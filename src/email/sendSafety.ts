import { json, nowIso, q1, run, sha256Hex } from "../core/db";

// Exact line every outbound merchant email must carry. Prompt text is not
// enforcement — the send path rejects a body that does not include this line.
export const DISCLOSED_ASSISTANCE_LINE =
  "Sent with the help of Company Service. This message was prepared by an assistant acting on the customer's behalf, not as the customer.";

export const DISCLOSURE_REJECTION =
  "outbound email rejected: disclosed-assistance line is required";

export interface SendApprovalBinding {
  bodyHash: string;
  recipient: string;
  mandateVersion: number;
  approvalId?: string;
  used?: boolean;
}

export function hasDisclosedAssistance(body: string): boolean {
  return body.includes(DISCLOSED_ASSISTANCE_LINE);
}

export function withDisclosedAssistance(body: string): string {
  if (hasDisclosedAssistance(body)) return body;
  return `${body.replace(/\s+$/, "")}\n\n${DISCLOSED_ASSISTANCE_LINE}`;
}

export function normalizeRecipient(recipient: string): string {
  return recipient.trim().toLowerCase();
}

export async function hashMessageBody(body: string): Promise<string> {
  return sha256Hex(body);
}

export async function buildSendBinding(input: {
  body: string;
  recipient: string;
  mandateVersion: number;
  approvalId?: string;
}): Promise<SendApprovalBinding> {
  return {
    bodyHash: await hashMessageBody(input.body),
    recipient: normalizeRecipient(input.recipient),
    mandateVersion: input.mandateVersion,
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    used: false,
  };
}

// The send must recompute the body hash and compare the approved tuple.
// A mismatch, a missing binding, or a second use is a rejection — never a send.
export async function verifySendBinding(input: {
  binding: SendApprovalBinding | null | undefined;
  body: string;
  recipient: string;
  mandateVersion: number;
}): Promise<{ ok: true; bodyHash: string } | { ok: false; error: string }> {
  const binding = input.binding;
  if (!binding) {
    return { ok: false, error: "send rejected: no per-send approval binding" };
  }
  if (binding.used) {
    return { ok: false, error: "send rejected: approval already used" };
  }
  if (!Number.isInteger(binding.mandateVersion) || binding.mandateVersion !== input.mandateVersion) {
    return { ok: false, error: "send rejected: mandate version does not match approval" };
  }
  if (normalizeRecipient(binding.recipient) !== normalizeRecipient(input.recipient)) {
    return { ok: false, error: "send rejected: recipient does not match approval" };
  }
  const bodyHash = await hashMessageBody(input.body);
  if (binding.bodyHash !== bodyHash) {
    return { ok: false, error: "send rejected: message body does not match approval" };
  }
  return { ok: true, bodyHash };
}

export function orgKeySendDecision(input: {
  hasCustomerRoute: boolean;
  orgKeyAvailable: boolean;
}): { ok: true } | { ok: false; error: string } {
  if (input.hasCustomerRoute) return { ok: true };
  if (input.orgKeyAvailable) {
    return {
      ok: false,
      error: "send rejected: organization send key is not used as a fallback when no customer route is connected",
    };
  }
  return { ok: true };
}

// One use: the first caller to stamp consumedAt wins. A second send cannot
// reuse the same approval, even for the same body and recipient.
export async function consumeSendBinding(db: D1Database, approvalId: string): Promise<boolean> {
  const row = await q1<{ detail_json: string | null; status: string }>(
    db,
    `SELECT detail_json, status FROM approval_requests WHERE id = ?`,
    approvalId,
  );
  if (!row || row.status !== "approved") return false;
  const detail = json<Record<string, unknown>>(row.detail_json, {});
  if (typeof detail.consumedAt === "string" && detail.consumedAt.length > 0) return false;
  const next = JSON.stringify({ ...detail, consumedAt: nowIso() });
  const res = await run(
    db,
    `UPDATE approval_requests
     SET detail_json = ?
     WHERE id = ? AND status = 'approved' AND json_extract(detail_json, '$.consumedAt') IS NULL`,
    next,
    approvalId,
  );
  return (res.meta?.changes ?? 0) > 0;
}
