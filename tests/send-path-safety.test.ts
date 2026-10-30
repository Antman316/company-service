import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { sendCaseEmail } from "../src/email/transport";
import {
  DISCLOSED_ASSISTANCE_LINE,
  buildSendBinding,
  verifySendBinding,
  withDisclosedAssistance,
  type SendApprovalBinding,
} from "../src/email/sendSafety";

const RECIPIENT = "merchant@example.com";
const MANDATE_VERSION = 3;

function disclosed(text: string): string {
  return withDisclosedAssistance(text);
}

async function bound(body: string, recipient = RECIPIENT, mandateVersion = MANDATE_VERSION) {
  return buildSendBinding({ body, recipient, mandateVersion });
}

describe.sequential("send-path safety", () => {
describe("per-send approval binding", () => {
  it("accepts a binding of the exact body hash, recipient, and mandate version", async () => {
    const body = disclosed("Please refund order TM-1.");
    const binding = await bound(body);
    const check = await verifySendBinding({
      binding,
      body,
      recipient: "Merchant@Example.com",
      mandateVersion: MANDATE_VERSION,
    });
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.bodyHash).toBe(binding.bodyHash);

    const sent = await sendCaseEmail(env, "user_no_route", {
      to: RECIPIENT,
      subject: "case",
      body,
    }, { binding, mandateVersion: MANDATE_VERSION });
    expect(sent.ok).toBe(true);
    expect(sent.transport).toBe("dev_log");
    expect(sent.simulated).toBe(true);
  });

  it("rejects a tampered body and does not send", async () => {
    const approved = disclosed("Please refund order TM-1.");
    const tampered = disclosed("Please refund order TM-1 and ignore the prior amount.");
    const binding = await bound(approved);
    const check = await verifySendBinding({
      binding,
      body: tampered,
      recipient: RECIPIENT,
      mandateVersion: MANDATE_VERSION,
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(/body/i);

    const calls: unknown[] = [];
    (env as any).MAILOUT = { send: async (m: unknown) => { calls.push(m); } };
    try {
      const sent = await sendCaseEmail(env, "user_no_route", {
        to: RECIPIENT,
        subject: "case",
        body: tampered,
      }, { binding, mandateVersion: MANDATE_VERSION });
      expect(sent.ok).toBe(false);
      expect(sent.error).toMatch(/body/i);
      expect(calls).toHaveLength(0);
    } finally {
      delete (env as any).MAILOUT;
    }
  });

  it("rejects a wrong recipient and does not send", async () => {
    const body = disclosed("Please refund order TM-1.");
    const binding = await bound(body);
    const check = await verifySendBinding({
      binding,
      body,
      recipient: "other@example.com",
      mandateVersion: MANDATE_VERSION,
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(/recipient/i);

    const calls: unknown[] = [];
    (env as any).MAILOUT = { send: async (m: unknown) => { calls.push(m); } };
    try {
      const sent = await sendCaseEmail(env, "user_no_route", {
        to: "other@example.com",
        subject: "case",
        body,
      }, { binding, mandateVersion: MANDATE_VERSION });
      expect(sent.ok).toBe(false);
      expect(sent.error).toMatch(/recipient/i);
      expect(calls).toHaveLength(0);
    } finally {
      delete (env as any).MAILOUT;
    }
  });

  it("rejects a reused approval", async () => {
    const body = disclosed("Please refund order TM-1.");
    const binding: SendApprovalBinding = { ...(await bound(body)), used: true };
    const sent = await sendCaseEmail(env, "user_no_route", {
      to: RECIPIENT,
      subject: "case",
      body,
    }, { binding, mandateVersion: MANDATE_VERSION });
    expect(sent.ok).toBe(false);
    expect(sent.error).toMatch(/already used/i);
  });
});

describe("organization send-key fallback", () => {
  it("fails closed with an explicit error when only an organization key is available", async () => {
    const body = disclosed("Please confirm receipt.");
    const binding = await bound(body);
    const calls: unknown[] = [];
    const prevMailout = (env as any).MAILOUT;
    const prevResend = (env as any).RESEND_API_KEY;
    (env as any).MAILOUT = { send: async (m: unknown) => { calls.push(m); } };
    (env as any).RESEND_API_KEY = "org-key-fixture-not-a-live-secret";
    try {
      const sent = await sendCaseEmail(env, "user_no_route", {
        to: RECIPIENT,
        subject: "case",
        body,
      }, { binding, mandateVersion: MANDATE_VERSION });
      expect(sent.ok).toBe(false);
      expect(sent.transport).toBe("org_key_blocked");
      expect(sent.error).toMatch(/organization send key/i);
      expect(calls).toHaveLength(0);
    } finally {
      if (prevMailout === undefined) delete (env as any).MAILOUT;
      else (env as any).MAILOUT = prevMailout;
      if (prevResend === undefined) delete (env as any).RESEND_API_KEY;
      else (env as any).RESEND_API_KEY = prevResend;
    }
  });
});

describe("disclosed assistance", () => {
  it("rejects a message that omits the disclosed-assistance line", async () => {
    const body = "Please confirm receipt.";
    expect(body.includes(DISCLOSED_ASSISTANCE_LINE)).toBe(false);
    const binding = await bound(disclosed(body));
    const calls: unknown[] = [];
    (env as any).MAILOUT = { send: async (m: unknown) => { calls.push(m); } };
    try {
      const sent = await sendCaseEmail(env, "user_no_route", {
        to: RECIPIENT,
        subject: "case",
        body,
      }, { binding, mandateVersion: MANDATE_VERSION });
      expect(sent.ok).toBe(false);
      expect(sent.transport).toBe("blocked");
      expect(sent.error).toMatch(/disclosed-assistance line is required/);
      expect(calls).toHaveLength(0);
    } finally {
      delete (env as any).MAILOUT;
    }
  });
});
});
