import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  apiGet,
  apiPost,
  createTestCase,
  dbAll,
  dbOne,
  getCaseDetail,
  grantMandate,
  signup,
} from "./helpers";
import { sendMerchantMessage } from "../src/core/agent";
import type { CaseRow } from "../src/core/types";

// Coverage for the e7a2208b fail-closed guard (src/core/agent.ts sendMerchantMessage):
// the adapter lane is simulation-only. A send on a real (non-`test-merchant`)
// adapter lane — or any adapter id the registry cannot resolve, e.g.
// `test-merchant` when ENVIRONMENT is production — must fail the action closed
// with no outbound send. executeAction only ever passes "test-merchant" | null,
// so the guard is exercised directly here; the approved-binding direction is
// covered end-to-end on the real email lane below.

const VERIFIED_AT = "2026-01-01T00:00:00Z";
const SAFE_BODY = "Please refund order TM-1.";

async function verifiedClient(suffix: string) {
  const c = await signup(`fc-${suffix}-${Date.now()}@t.dev`);
  const me = await apiGet(c, "/api/auth/me");
  const uid = me.body.user.id as string;
  await env.DB.prepare(`UPDATE users SET email_verified_at = ? WHERE id = ?`)
    .bind(VERIFIED_AT, uid)
    .run();
  return { c, uid };
}

async function caseRow(caseId: string): Promise<CaseRow> {
  const row = await dbOne<CaseRow>(`SELECT * FROM cases WHERE id = ?`, caseId);
  if (!row) throw new Error("fixture case missing");
  return row;
}

async function insertProposedSend(caseId: string) {
  const id = `act_fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const payload = JSON.stringify({ body: SAFE_BODY });
  await env.DB.prepare(
    `INSERT INTO case_actions (id, case_id, kind, payload_json, policy_class, status, idempotency_key)
     VALUES (?, ?, 'send_message', ?, 'AUTO_ALLOWED', 'proposed', ?)`,
  )
    .bind(id, caseId, payload, `idem_${id}`)
    .run();
  return { id, kind: "send_message", payload_json: payload };
}

async function outboundMessages(caseId: string) {
  return dbAll<{ id: string; status: string; meta_json: string | null }>(
    `SELECT em.id, em.status, em.meta_json FROM external_messages em
     JOIN external_conversations ec ON em.conversation_id = ec.id
     WHERE ec.case_id = ? AND em.direction = 'out'`,
    caseId,
  );
}

async function eventsFor(caseId: string, type: string, actionId?: string) {
  const rows = await dbAll<{ type: string; actor: string; data_json: string | null }>(
    `SELECT type, actor, data_json FROM case_events WHERE case_id = ? AND type = ?`,
    caseId,
    type,
  );
  return actionId ? rows.filter((r) => (r.data_json ?? "").includes(actionId)) : rows;
}

describe("adapter lane fail-closed guard", () => {
  it("fails closed on a real (non-test-merchant) adapter lane — no send, no side-effects", async () => {
    const { c } = await verifiedClient("real");
    const caseId = await createTestCase(c, "please refund my order");
    await grantMandate(c, caseId);
    const action = await insertProposedSend(caseId);
    const before = (await outboundMessages(caseId)).length;

    const res = await sendMerchantMessage(
      env,
      await caseRow(caseId),
      action,
      "email",
      null,
      "real-adapter-9",
      { assisted: false },
    );
    expect(res.continue).toBe(true);

    const act = await dbOne<{ status: string; error: string | null }>(
      `SELECT status, error FROM case_actions WHERE id = ?`,
      action.id,
    );
    expect(act?.status).toBe("failed");
    expect(act?.error ?? "").toMatch(
      /unknown adapter: real-adapter-9|simulation-only|per-send approval gate/,
    );

    const failed = await eventsFor(caseId, "action_failed", action.id);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.actor).toBe("policy");
    // Held fully closed: the action never reached adapter.execute — no outbound
    // message was recorded and no send event fired.
    expect(await eventsFor(caseId, "message_sent", action.id)).toHaveLength(0);
    expect((await outboundMessages(caseId)).length).toBe(before);
  });

  it("fails closed when the adapter id cannot resolve — test-merchant under production ENVIRONMENT", async () => {
    const { c } = await verifiedClient("prod");
    const caseId = await createTestCase(c, "please refund my order");
    await grantMandate(c, caseId);
    const action = await insertProposedSend(caseId);
    const before = (await outboundMessages(caseId)).length;

    // The registry drops the sim adapter outside non-production envs; a stale
    // test-merchant lane on prod must fail closed rather than send.
    const prodEnv = { ...env, ENVIRONMENT: "production" as const };
    const res = await sendMerchantMessage(
      prodEnv,
      await caseRow(caseId),
      action,
      "email",
      null,
      "test-merchant",
      { assisted: false },
    );
    expect(res.continue).toBe(true);

    const act = await dbOne<{ status: string; error: string | null }>(
      `SELECT status, error FROM case_actions WHERE id = ?`,
      action.id,
    );
    expect(act?.status).toBe("failed");
    expect(act?.error ?? "").toMatch(/unknown adapter: test-merchant/);
    expect((await outboundMessages(caseId)).length).toBe(before);
  });

  it("permits the registered test-merchant sim lane (control — only non-sim lanes are blocked)", async () => {
    const { c } = await verifiedClient("sim");
    const caseId = await createTestCase(c, "please refund my order");
    await grantMandate(c, caseId);
    const action = await insertProposedSend(caseId);
    const before = (await outboundMessages(caseId)).length;

    const res = await sendMerchantMessage(
      env,
      await caseRow(caseId),
      action,
      "chat",
      null,
      "test-merchant",
      { assisted: false },
    );
    expect(res.continue).toBe(true);

    const act = await dbOne<{ status: string; error: string | null }>(
      `SELECT status, error FROM case_actions WHERE id = ?`,
      action.id,
    );
    expect(act?.status).toBe("executed");
    expect(await eventsFor(caseId, "message_sent", action.id)).toHaveLength(1);
    expect((await outboundMessages(caseId)).length).toBe(before + 1);
  });
});

describe("real-lane per-send approval gate (end-to-end)", () => {
  async function chewyCase(suffix: string) {
    const { c } = await verifiedClient(suffix);
    const created = await apiPost(c, "/api/cases", { text: "Chewy owes me a $50 refund" });
    const caseId = created.body.caseId as string;
    await env.DB.prepare(
      `UPDATE cases SET company_id = 'cmp_chewy', company_name = 'Chewy' WHERE id = ?`,
    )
      .bind(caseId)
      .run();
    await grantMandate(c, caseId);
    return { c, caseId };
  }

  it("holds the send without an approved binding, then an approved binding follows the gate path", async () => {
    const { c, caseId } = await chewyCase("chewy-approve");

    // Held at the gate: approval requested, action parked, nothing sent.
    const d1 = await getCaseDetail(c, caseId);
    expect(d1.case.status).toBe("WAITING_FOR_CUSTOMER");
    const approval = d1.approvals.find(
      (a: { kind: string }) => a.kind === "send_binding",
    );
    expect(approval).toBeTruthy();
    expect(approval.status).toBe("pending");
    const held = await dbOne<{ status: string }>(
      `SELECT status FROM case_actions WHERE case_id = ? AND kind = 'send_message'`,
      caseId,
    );
    expect(held?.status).toBe("awaiting_approval");
    expect(await outboundMessages(caseId)).toHaveLength(0);

    // Approve the exact send — the verified binding follows the gate path.
    const dec = await apiPost(c, `/api/approvals/${approval.id}/decide`, {
      optionId: "approve",
    });
    expect(dec.status).toBe(200);

    const act = await dbOne<{ status: string; error: string | null }>(
      `SELECT status, error FROM case_actions WHERE case_id = ? AND kind = 'send_message'`,
      caseId,
    );
    expect(act?.status).toBe("executed");

    const outs = await outboundMessages(caseId);
    expect(outs).toHaveLength(1);
    expect(outs[0]!.status).toBe("sent");
    expect(outs[0]!.meta_json ?? "").toContain("dev_log");
    expect(outs[0]!.meta_json ?? "").toContain('"simulated":true');

    // Single-use binding was consumed by the send.
    const consumed = await dbOne<{ detail_json: string | null }>(
      `SELECT detail_json FROM approval_requests WHERE id = ?`,
      approval.id,
    );
    expect(consumed?.detail_json ?? "").toContain("consumedAt");
    expect(await eventsFor(caseId, "message_sent")).toHaveLength(1);
  });

  it("a rejected binding never sends — action rejected, zero outbound messages", async () => {
    const { c, caseId } = await chewyCase("chewy-reject");

    const d1 = await getCaseDetail(c, caseId);
    const approval = d1.approvals.find(
      (a: { kind: string }) => a.kind === "send_binding",
    );
    expect(approval).toBeTruthy();

    const dec = await apiPost(c, `/api/approvals/${approval.id}/decide`, {
      optionId: "reject",
    });
    expect(dec.status).toBe(200);

    const act = await dbOne<{ status: string; error: string | null }>(
      `SELECT status, error FROM case_actions WHERE case_id = ? AND kind = 'send_message'`,
      caseId,
    );
    expect(act?.status).toBe("rejected");
    expect(await eventsFor(caseId, "send_binding_rejected")).toHaveLength(1);
    expect(await outboundMessages(caseId)).toHaveLength(0);
  });
});
