import { describe, it, expect } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { signup, createTestCase, grantMandate, dbAll, dbOne } from "./helpers";
import { scheduleFollowUp, markFired } from "../src/core/followups";
import { reportError, backupDue, runDailyBackup, inboundRawKey } from "../src/core/ops";
import { caseEmailToken } from "../src/email/threading";
import { nowIso } from "../src/core/db";
import { CaseWorkflow } from "../src/core/caseWorkflow";
import { seedRegistry } from "../src/adapters/registry";

function fakeQueueMessage(body: unknown) {
  const m = {
    id: `q_${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    acked: false,
    retried: false,
    ack() { m.acked = true; },
    retry() { m.retried = true; },
  };
  return m;
}

function fakeBatch(messages: ReturnType<typeof fakeQueueMessage>[]) {
  return {
    queue: "cs-inbound",
    retryAll() {},
    ackAll() {},
    messages,
  } as unknown as MessageBatch<any>;
}

function rawMime(opts: { to: string; from: string; subject?: string; messageId: string; body?: string }) {
  return new TextEncoder().encode(
    `From: ${opts.from}\r\nTo: ${opts.to}\r\nSubject: ${opts.subject ?? "reply"}\r\n` +
      `Message-ID: <${opts.messageId}>\r\nContent-Type: text/plain\r\n\r\n` +
      (opts.body ?? "Hello, your refund is being processed."),
  );
}

describe("M9 ops & reliability", () => {
  it("markFired is an atomic claim — only the first caller wins", async () => {
    const c = await signup("m9a@test.local");
    const caseId = await createTestCase(c, "testing atomic follow-up claim");
    await grantMandate(c, caseId);
    const fupId = await scheduleFollowUp(env.DB, caseId, "first_contact", new Date(Date.now() - 1000).toISOString(), { via: "test" });
    expect(await markFired(env.DB, fupId)).toBe(true);
    expect(await markFired(env.DB, fupId)).toBe(false);
    expect(await markFired(env.DB, fupId)).toBe(false);
    const row = await dbOne<{ status: string }>(`SELECT status FROM follow_ups WHERE id = ?`, fupId);
    expect(row?.status).toBe("fired");
  });

  it("scheduleFollowUp works with no CASE_WORKFLOW binding (cron backstop)", async () => {
    const c = await signup("m9b@test.local");
    const caseId = await createTestCase(c, "workflow-less env");
    await grantMandate(c, caseId);
    const fupId = await scheduleFollowUp(env.DB, caseId, "merchant_check", nowIso(), { via: "test" }, env);
    const row = await dbOne<{ status: string }>(`SELECT status FROM follow_ups WHERE id = ?`, fupId);
    expect(row?.status).toBe("pending");
  });

  it("queue consumer ingests raw MIME from R2 and is idempotent on redelivery", async () => {
    const c = await signup("m9c@test.local");
    const caseId = await createTestCase(c, "queue consumer case");
    await grantMandate(c, caseId);
    await seedRegistry(env.DB);
    const token = caseEmailToken(caseId);
    const to = `case+${token}@${(env.INBOUND_ADDRESS ?? "cases@case.company-service.test").split("@")[1]}`;
    const r2Key = inboundRawKey();
    await env.EVIDENCE.put(r2Key, rawMime({
      to,
      from: "support@test-merchant.demo",
      subject: "Re: your case",
      messageId: `q-${caseId}@test`,
      body: "We are reviewing your return request.",
    }));
    const batch = fakeBatch([fakeQueueMessage({ r2Key, caseId, enqueuedAt: nowIso() })]);
    await worker.queue!(batch, env);
    const MSG_SQL = `SELECT m.id FROM external_messages m JOIN external_conversations cv ON cv.id = m.conversation_id WHERE cv.case_id = ? AND m.direction = 'in'`;
    const msgs = await dbAll<{ id: string }>(MSG_SQL, caseId);
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(await env.EVIDENCE.get(r2Key)).toBeNull();
    // Redelivery with the same message-id is a no-op (dedup inside ingest).
    const r2Key2 = inboundRawKey();
    await env.EVIDENCE.put(r2Key2, rawMime({
      to,
      from: "support@test-merchant.demo",
      messageId: `q-${caseId}@test`,
    }));
    await worker.queue!(fakeBatch([fakeQueueMessage({ r2Key: r2Key2, caseId, enqueuedAt: nowIso() })]), env);
    const msgs2 = await dbAll<{ id: string }>(MSG_SQL, caseId);
    expect(msgs2.length).toBe(msgs.length);
  });

  it("reportError audits once per error but alerts at most once per sig/hour", async () => {
    const before = await dbOne<{ n: number }>(`SELECT COUNT(*) n FROM audit_events WHERE type = 'error_alert'`);
    const err = new Error("m9-sig-test-boom");
    await reportError(env, err, { route: "/api/x", kind: "m9sig" });
    await reportError(env, err, { route: "/api/x", kind: "m9sig" });
    const errs = await dbAll<{ id: string }>(`SELECT id FROM audit_events WHERE type = 'unhandled_error' AND json_extract(data_json, '$.kind') = 'm9sig'`);
    expect(errs.length).toBe(2);
    const after = await dbOne<{ n: number }>(`SELECT COUNT(*) n FROM audit_events WHERE type = 'error_alert'`);
    // No MAILOUT in tests → alert is recorded (dedup keyed on it) even though
    // send is skipped.
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);
  });

  it("daily backup writes manifest + table JSONL and gates itself to once/day", async () => {
    expect(await backupDue(env.DB)).toBe(true);
    const r = await runDailyBackup(env);
    expect(r.tables).toBeGreaterThan(5);
    expect(r.rows).toBeGreaterThan(0);
    const manifest = await env.EVIDENCE.get(`backups/${r.date}/manifest.json`);
    expect(manifest).toBeTruthy();
    const m = JSON.parse(await manifest!.text()) as { tables: Record<string, number> };
    expect(m.tables.audit_events).toBeGreaterThan(0);
    expect(await backupDue(env.DB)).toBe(false);
  });

  it("CaseWorkflow claims and fires a due follow-up itself (no cron)", async () => {
    const c = await signup("m9d@test.local");
    const caseId = await createTestCase(c, "workflow fire path");
    await grantMandate(c, caseId);
    const fupId = await scheduleFollowUp(env.DB, caseId, "first_contact", new Date(Date.now() - 1000).toISOString(), { via: "test" });
    // run() only touches this.env — call it on a bare receiver rather than
    // constructing the entrypoint (miniflare's ctor needs a real ctx).
    const wf = CaseWorkflow.prototype;
    const step = {
      do: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      sleepUntil: async () => {},
      sleep: async () => {},
    } as unknown;
    await wf.run.call({ env }, { payload: { followUpId: fupId, caseId } } as never, step as never);
    const row = await dbOne<{ status: string }>(`SELECT status FROM follow_ups WHERE id = ?`, fupId);
    expect(row?.status).toBe("fired");
    // The fire left the usual trail (transition + a send_followup proposal
    // waiting on approval for test merchant, or a sent message).
    const trails = await dbAll<{ id: string }>(`SELECT id FROM case_events WHERE case_id = ?`, caseId);
    expect(trails.length).toBeGreaterThan(0);
  });
});
