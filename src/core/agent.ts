import { checkCoverage, findCompany, getAdapter } from "../adapters/registry";
import { TEST_MERCHANT_EMAIL } from "../adapters/testMerchant";
import { sendCaseEmail } from "../email/transport";
import { caseAddress, caseEmailToken, subjectTag } from "../email/threading";
import { runModel } from "../providers/registry";
import { extractJsonSafe } from "../providers/local";
import { detectInjection, SYSTEM_POLICY_PREAMBLE, wrapUntrusted } from "../security/injection";
import { addClaim, addEvidence } from "./evidence";
import { createApproval } from "./approvals";
import { getCase, transitionCase, createCase } from "./caseEngine";
import { addMs, json, newId, nowIso, q, q1, run } from "./db";
import { caseEvent, auditEvent } from "./events";
import { dueFollowUps, markFired, scheduleFollowUp, cancelFollowUps } from "./followups";
import { getActiveMandate } from "./mandate";
import { latestOutcome, recordOutcome } from "./outcomes";
import { describeAction, nextProposedAction, proposeAction } from "./actions";
import { classifyAction, classifyMerchantOffer } from "./policy";
import {
  addDeadline,
  advanceRung,
  bumpDeflectionStreak,
  deflectionNudgeBody,
  detectDeflection,
  executeDraftAction,
  hasMissedPromiseDeadline,
  resetDeflectionStreak,
  runDeadlineSweep,
  syncEscalationStatus,
} from "./escalation";
import type { CaseRow, CaseState, ExecutionContext } from "./types";

const MAX_STEPS_PER_CYCLE = 8;

// ---------------------------------------------------------------------------
// Intake: plain-English problem -> structured objective + claims (provenance
// preserved) + a drafted mandate for the customer to approve.
// ---------------------------------------------------------------------------

export interface ExtractedObjective {
  company: string;
  issueType: string;
  desiredOutcome: string;
  amountCents: number | null;
  currency: string;
  orderRef: string | null;
  trackingRef: string | null;
  missingInfo: string[];
  claims: { text: string; kind: string }[];
}

export async function extractObjective(
  env: Env,
  userId: string,
  intakeText: string,
): Promise<ExtractedObjective> {
  const resp = await runModel(env, { userId }, {
    role: "light",
    system: SYSTEM_POLICY_PREAMBLE,
    userContext: `TASK:extract_objective\n${intakeText}`,
    responseFormat: "json",
  });
  const parsed = extractJsonSafe(resp.text) as Partial<ExtractedObjective> | null;
  return {
    company: parsed?.company ?? "unknown company",
    issueType: parsed?.issueType ?? "other_post_purchase",
    desiredOutcome: parsed?.desiredOutcome ?? "resolution per customer request",
    amountCents: parsed?.amountCents ?? null,
    currency: parsed?.currency ?? "USD",
    orderRef: parsed?.orderRef ?? null,
    trackingRef: parsed?.trackingRef ?? null,
    missingInfo: parsed?.missingInfo ?? [],
    claims: parsed?.claims ?? [],
  };
}

// Suggested mandate for a retail post-purchase case. The customer edits and
// activates it — nothing here is self-granted.
export function suggestedMandate(input: { amountCents?: number | null; orderRef?: string | null }) {
  const amount = input.amountCents != null ? `$${(input.amountCents / 100).toFixed(2)}` : "the claimed amount";
  return {
    authorized: [
      "contact_company",
      "request_refund",
      "share_order_number",
      "share_tracking_number",
      "share_evidence",
      "follow_up",
      "request_escalation",
      "contact_executive",
    ],
    approvalRequired: [
      "accept_partial_refund",
      "accept_store_credit",
      "accept_replacement",
      "agree_to_fee",
      "change_delivery",
      "accept_new_terms",
      "close_case_satisfied",
    ],
    prohibited: [
      "make_purchase",
      "share_full_profile",
      "change_security_credentials",
      "accept_legal_settlement",
      "submit_false_statement",
    ],
    note: `Agent may discuss this order, request ${amount}, share order/tracking numbers, and follow up. Anything else comes back to you.`,
  };
}

export async function createCaseFromText(
  env: Env,
  userId: string,
  intakeText: string,
): Promise<{ caseId: string; objective: ExtractedObjective }> {
  const objective = await extractObjective(env, userId, intakeText);
  const company = await findCompany(env.DB, objective.company);

  const caseId = await createCase(env.DB, userId, {
    title: objective.desiredOutcome !== "resolution per customer request"
      ? `${objective.company} — ${objective.desiredOutcome}`
      : `${objective.company} — ${objective.issueType.replace(/_/g, " ")}`,
    intakeText,
    companyId: company?.id ?? null,
    companyName: company?.name ?? objective.company,
    issueType: objective.issueType,
    desiredOutcome: objective.desiredOutcome,
    amountCents: objective.amountCents,
    currency: objective.currency,
    meta: { orderRef: objective.orderRef, trackingRef: objective.trackingRef },
  });

  // Store the raw statement as evidence + each extracted fact as a claim with
  // honest provenance (CUSTOMER_STATED — not verified).
  const evId = await addEvidence(env.DB, env, caseId, {
    kind: "statement",
    text: intakeText,
    source: "customer",
    label: "Initial problem description",
  });
  for (const c of objective.claims) {
    await addClaim(env.DB, caseId, {
      text: c.text,
      status: "CUSTOMER_STATED",
      sourceType: "customer",
      evidenceId: evId,
    });
  }
  if (objective.orderRef && !objective.claims.some((c) => c.text.includes(objective.orderRef!))) {
    await addClaim(env.DB, caseId, {
      text: `Order reference ${objective.orderRef}`,
      status: "CUSTOMER_STATED",
      sourceType: "customer",
      evidenceId: evId,
    });
  }

  // Only a missing order reference blocks readiness; other gaps (tracking,
  // exact amount) are recorded as unverified claims, not blockers.
  const blocking = objective.missingInfo.filter((m) => m === "order_number");
  const next = blocking.length > 0 ? "NEEDS_INFORMATION" : "READY";
  await transitionCase(env.DB, caseId, next, {
    reason: blocking.length > 0
      ? `missing: ${objective.missingInfo.join(", ")}`
      : "objective captured",
  });
  return { caseId, objective };
}

// ---------------------------------------------------------------------------
// The bounded agent cycle. One call = at most MAX_STEPS_PER_CYCLE actions.
// Everything durable lives in D1; a crash mid-cycle leaves consistent state
// because sends carry deterministic idempotency keys.
// ---------------------------------------------------------------------------

export async function advanceCase(
  env: Env,
  caseId: string,
  trigger: string,
): Promise<{ caseId: string; status: string; stepsRun: number }> {
  const db = env.DB;
  const caseRow = await getCase(db, caseId);
  if (!caseRow) throw new Error(`case ${caseId} not found`);
  await caseEvent(db, caseId, "agent_cycle_start", "system", { trigger });

  if (caseRow.paused) {
    await caseEvent(db, caseId, "cycle_skipped", "system", { reason: "paused" });
    return { caseId, status: caseRow.status, stepsRun: 0 };
  }
  if (["RESOLVED", "CANCELLED", "UNRESOLVED", "UNSUPPORTED"].includes(caseRow.status)) {
    return { caseId, status: caseRow.status, stepsRun: 0 };
  }

  const mandate = await getActiveMandate(db, caseId);
  if (!mandate) {
    if (["READY", "PLANNING", "IN_PROGRESS"].includes(caseRow.status)) {
      await transitionCase(db, caseId, "AWAITING_AUTHORIZATION", {
        reason: "no active mandate — waiting on customer",
      });
    }
    return { caseId, status: "AWAITING_AUTHORIZATION", stepsRun: 0 };
  }

  // A granted mandate means the customer chose to proceed; missing-information
  // flags remain visible as claims but no longer block the case.
  if (caseRow.status === "NEEDS_INFORMATION") {
    await transitionCase(db, caseId, "READY", { reason: "customer authorized proceeding" });
  }

  // Coverage gate — never pretend an unsupported workflow works.
  const coverage = await checkCoverage(db, {
    companyId: caseRow.company_id ?? undefined,
    companyName: caseRow.company_name ?? undefined,
    issueType: caseRow.issue_type ?? undefined,
  });
  if (coverage.coverage === "uncovered") {
    await transitionCase(db, caseId, "UNSUPPORTED", {
      reason: coverage.reason,
      actor: "system",
    });
    await caseEvent(db, caseId, "manual_handoff", "system", {
      reason: coverage.reason,
      guidance:
        "This workflow cannot currently be completed automatically. Company Service can draft communications and track the case while you act on the manual steps.",
    });
    return { caseId, status: "UNSUPPORTED", stepsRun: 0 };
  }

  // Promotion chain — re-read status after each step; the row mutates.
  let status = (await getCase(db, caseId))!.status;
  if (status === "READY") {
    await transitionCase(db, caseId, "AWAITING_AUTHORIZATION", { reason: "mandate granted" });
    status = "AWAITING_AUTHORIZATION";
  }
  if (status === "AWAITING_AUTHORIZATION") {
    await transitionCase(db, caseId, "PLANNING", { reason: "mandate active, planning" });
    status = "PLANNING";
  }
  if (status === "PLANNING") {
    await ensurePlan(env, caseRow, mandate);
    await transitionCase(db, caseId, "IN_PROGRESS", { reason: "plan created" });
  }

  let stepsRun = 0;
  const channel = coverage.channel === "chat" || coverage.channel === "email" ? coverage.channel : "chat";

  while (stepsRun < MAX_STEPS_PER_CYCLE) {
    const action = await nextProposedAction(db, caseId);
    if (!action) break;
    stepsRun++;

    const decision = classifyAction({ kind: action.kind, payload: json(action.payload_json, {}) }, mandate);
    await run(db, `UPDATE case_actions SET policy_class = ? WHERE id = ?`, decision.policyClass, action.id);
    await caseEvent(db, caseId, "action_classified", "policy", {
      actionId: action.id,
      kind: action.kind,
      class: decision.policyClass,
      reason: decision.reason,
    });

    if (decision.policyClass === "PROHIBITED") {
      await run(db, `UPDATE case_actions SET status = 'rejected', error = ? WHERE id = ?`, decision.reason, action.id);
      await syncEscalationStatus(db, action.id);
      await auditEvent(db, { caseId, type: "action_prohibited", severity: "warning", data: { kind: action.kind, reason: decision.reason } });
      continue;
    }
    if (decision.policyClass === "UNSUPPORTED") {
      await run(db, `UPDATE case_actions SET status = 'skipped', error = ? WHERE id = ?`, decision.reason, action.id);
      await syncEscalationStatus(db, action.id);
      continue;
    }
    if (decision.policyClass === "USER_APPROVAL_REQUIRED") {
      await run(db, `UPDATE case_actions SET status = 'awaiting_approval' WHERE id = ?`, action.id);
      await syncEscalationStatus(db, action.id);
      const isDraft = action.kind.startsWith("draft_");
      const approvalId = await createApproval(db, caseId, {
        actionId: action.id,
        kind: "action_approval",
        summary: isDraft
          ? `Draft ready for your review: ${describeAction(action.kind)} — you review it and file it yourself; the system never files on your behalf.`
          : `Company Service wants to: ${describeAction(action.kind)}. Reason: ${decision.reason}`,
        detail: { actionKind: action.kind, payload: json(action.payload_json, {}) },
        options: [
          { id: "approve", label: "Approve", kind: "approve" },
          { id: "reject", label: "Reject", kind: "reject" },
        ],
      });
      await run(db, `UPDATE case_actions SET approval_id = ? WHERE id = ?`, approvalId, action.id);
      const cur = await getCase(db, caseId);
      if (cur && !["WAITING_FOR_CUSTOMER", "RESOLUTION_PROPOSED"].includes(cur.status)) {
        await transitionCase(db, caseId, "WAITING_FOR_CUSTOMER", { reason: "approval pending" });
      }
      return { caseId, status: "WAITING_FOR_CUSTOMER", stepsRun };
    }

    // AUTO_ALLOWED — execute through the selected adapter/channel.
    const outcome = await executeAction(env, caseRow, action, channel, {
      channelAddress: coverage.channelAddress,
      assisted: coverage.coverage === "assisted",
    });
    await syncEscalationStatus(db, action.id);
    if (!outcome.continue) return { caseId, status: outcome.status ?? caseRow.status, stepsRun };
  }

  return { caseId, status: (await getCase(db, caseId))!.status, stepsRun };
}

// Propose/classify plumbing lives in ./actions (shared with the escalation
// engine without a module cycle).

async function ensurePlan(env: Env, caseRow: CaseRow, mandate: unknown): Promise<void> {
  const db = env.DB;
  const existing = await q1<{ id: string }>(
    db,
    `SELECT id FROM case_plans WHERE case_id = ? AND status IN ('draft','active') ORDER BY version DESC LIMIT 1`,
    caseRow.id,
  );
  if (existing) return;

  const resp = await runModel(env, { userId: caseRow.user_id, caseId: caseRow.id }, {
    role: "reasoning",
    system: SYSTEM_POLICY_PREAMBLE,
    userContext:
      `TASK:plan\nCOMPANY=${caseRow.company_name ?? "unknown"}\nISSUE=${caseRow.issue_type ?? ""}\nOBJECTIVE=${caseRow.desired_outcome ?? ""}\nMANDATE=${JSON.stringify(mandate)}`,
    responseFormat: "json",
  });
  const parsed = extractJsonSafe(resp.text) as { steps?: { kind: string; reason?: string }[] } | null;

  const planId = newId("plan");
  await run(
    db,
    `INSERT INTO case_plans (id, case_id, version, summary, status) VALUES (?,?,?,?, 'active')`,
    planId,
    caseRow.id,
    1,
    `Contact merchant, request outcome, follow up durably.`,
  );
  await caseEvent(db, caseRow.id, "plan_created", "agent", {
    planId,
    steps: parsed?.steps ?? [],
    modelNote: "plan produced by model layer; actions still gated by policy",
  });

  // Materialize the plan's first action only — later steps are decided as the
  // conversation evolves (keeps cycles bounded and honest).
  await proposeAction(db, caseRow.id, "send_message", {}, `${caseRow.id}:open:${planId}`, planId);
}

async function executeAction(
  env: Env,
  caseRow: CaseRow,
  action: { id: string; kind: string; payload_json: string | null },
  channel: string,
  coverage: { channelAddress?: string; assisted: boolean },
): Promise<{ continue: boolean; status?: string }> {
  const db = env.DB;
  const companyId = caseRow.company_id ?? "";
  const adapter = getAdapter(companyId === "cmp_testmerchant" ? "test-merchant" : (await adapterFor(db, companyId)) ?? "");
  const scenario = caseScenario(caseRow);

  // Everything that talks to a merchant is a send over the case's channel.
  // contact_executive always goes over email to the playbook's executive contact.
  const SEND_KINDS = new Set([
    "send_message", "send_email", "send_followup", "request_escalation",
    "request_refund_status", "check_merchant_status",
    "share_evidence", "share_order_number", "share_tracking_number",
    "escalate_policy_cite", "escalate_request_human", "escalate_supervisor",
    "contact_executive",
  ]);
  if (SEND_KINDS.has(action.kind)) {
    const chan = action.kind === "contact_executive" ? "email" : channel;
    return sendMerchantMessage(env, caseRow, action, chan, scenario, adapter ? "test-merchant" : null, coverage);
  }
  // Gated kinds should never reach here unapproved; defense in depth.
  await run(db, `UPDATE case_actions SET status = 'skipped', error = 'unhandled kind at execution' WHERE id = ?`, action.id);
  return { continue: true };
}

async function adapterFor(db: D1Database, companyId: string): Promise<string | null> {
  const row = await q1<{ adapter_id: string | null }>(db, `SELECT adapter_id FROM companies WHERE id = ?`, companyId);
  return row?.adapter_id ?? null;
}

function caseScenario(caseRow: CaseRow): string | null {
  const meta = json<{ scenario?: string }>(caseRow.meta, {});
  return meta.scenario ?? null;
}

async function sendMerchantMessage(
  env: Env,
  caseRow: CaseRow,
  action: { id: string; kind: string; payload_json: string | null },
  channel: string,
  scenario: string | null,
  adapterId: string | null,
  coverage: { channelAddress?: string; assisted: boolean },
): Promise<{ continue: boolean; status?: string }> {
  const db = env.DB;
  const companyName = caseRow.company_name ?? "the company";

  // An explicit body in the action payload (set by our own code paths — e.g.
  // "customer declined the offer") is used verbatim; otherwise compose.
  const explicitBody = json<{ body?: string }>(action.payload_json, {}).body;
  let body: string;
  if (explicitBody) {
    body = explicitBody;
  } else {
    const compose = await runModel(env, { userId: caseRow.user_id, caseId: caseRow.id }, {
      role: "light",
      system: SYSTEM_POLICY_PREAMBLE,
      userContext:
        `TASK:compose\nPURPOSE=${action.kind === "send_followup" ? "followup" : action.kind === "request_escalation" ? "escalation" : "initial"}\nCOMPANY=${companyName}\nOBJECTIVE=${caseRow.desired_outcome ?? ""}\nORDER_REF=${json<{ orderRef?: string }>(caseRow.meta, {}).orderRef ?? ""}\nTRACKING=${json<{ trackingRef?: string }>(caseRow.meta, {}).trackingRef ?? ""}\nCUSTOMER=the customer`,
      responseFormat: "json",
    });
    const composed = extractJsonSafe(compose.text) as { body?: string } | null;
    body = composed?.body ?? `Hello ${companyName}, regarding this order issue: ${caseRow.desired_outcome ?? "please review"}.`;
  }

  const conv = await ensureConversation(db, caseRow.id, channel, adapterId ?? "none");
  const subject = `${subjectTag(caseRow.id)} Regarding ${companyName} order`;

  // ASSISTED lane: the supported channel is one we cannot automate (a merchant
  // chat portal, an authenticated support page). The agent drafts; the
  // customer sends it in their own browser session — zero credential sharing,
  // zero bot evasion — and pastes the reply back. That reply re-enters this
  // same ingest pipeline via /assisted/reply.
  if (coverage.assisted) {
    const msgId = await recordMessage(db, conv, "out", subject, body, "drafted", {
      transport: "assisted",
      channel,
      target: coverage.channelAddress ?? "merchant support page",
    });
    await run(
      db,
      `UPDATE case_actions SET status='awaiting_customer', result_json=? WHERE id=?`,
      JSON.stringify({ draft: body, messageId: msgId, target: coverage.channelAddress ?? null }),
      action.id,
    );
    await caseEvent(db, caseRow.id, "assisted_step_ready", "agent", {
      actionId: action.id,
      channel,
      target: coverage.channelAddress ?? "merchant support page",
      draftPreview: body.slice(0, 160),
    });
    await transitionCase(db, caseRow.id, "WAITING_FOR_CUSTOMER", {
      reason: "assisted step — send the drafted message in their support channel, then paste the reply",
      actor: "agent",
    });
    return { continue: false, status: "WAITING_FOR_CUSTOMER" };
  }

  const outboundMsgId = await recordMessage(db, conv, "out", subject, body, "queued");

  const ctx: ExecutionContext = {
    caseId: caseRow.id,
    userId: caseRow.user_id,
    companyName,
    conversationId: conv,
    env,
    now: nowIso,
  };

  let resultData: Record<string, unknown> = {};
  if (adapterId) {
    const adapter = getAdapter(adapterId)!;
    const res = await adapter.execute(
      { kind: action.kind, payload: { ...json<Record<string, unknown>>(action.payload_json, {}), scenario, body } },
      ctx,
    );
    resultData = res.data ?? {};
    if (!res.ok) {
      await run(db, `UPDATE case_actions SET status='failed', error=? WHERE id=?`, res.error ?? "adapter error", action.id);
      await caseEvent(db, caseRow.id, "action_failed", "system", { actionId: action.id, error: res.error });
      return { continue: true };
    }
  } else if (channel === "email") {
    const payloadTo = json<{ to?: string }>(action.payload_json, {}).to;
    const to = payloadTo ?? (adapterId === "test-merchant" ? TEST_MERCHANT_EMAIL : (coverage.channelAddress ?? ""));
    if (!to) {
      await run(db, `UPDATE case_actions SET status='failed', error='no destination address registered for email channel' WHERE id=?`, action.id);
      await run(db, `UPDATE external_messages SET status='failed' WHERE id=?`, outboundMsgId);
      return { continue: true };
    }
    // Stamp our own RFC Message-ID so the merchant's In-Reply-To threads back
    // even when they mangle the subject tag.
    const domain = env.EMAIL_DOMAIN ?? "agentmasterkey.com";
    const stampedId = `cs-${caseEmailToken(caseRow.id)}-${action.id.replace(/^act_/, "").slice(0, 10)}@${domain}`;
    const sent = await sendCaseEmail(env, caseRow.user_id, {
      to,
      subject,
      body,
      replyTo: env.INBOUND_ADDRESS ?? caseAddress(caseRow.id, domain),
      messageId: stampedId,
    });
    // Record the provider outcome + the stamped id on the outbound row.
    await run(
      db,
      `UPDATE external_messages SET status=?, external_id=?, meta_json=? WHERE id=?`,
      sent.ok ? "sent" : "failed",
      stampedId,
      JSON.stringify({ transport: sent.transport, providerId: sent.externalId ?? null, simulated: sent.simulated ?? false, to }),
      outboundMsgId,
    );
    if (!sent.ok) {
      await run(db, `UPDATE case_actions SET status='failed', error=? WHERE id=?`, sent.error ?? "send failed", action.id);
      return { continue: true };
    }
  } else {
    await run(db, `UPDATE external_messages SET status='sent' WHERE id=?`, outboundMsgId);
  }

  await run(
    db,
    `UPDATE case_actions SET status='executed', executed_at=?, result_json=? WHERE id=?`,
    nowIso(),
    JSON.stringify(resultData),
    action.id,
  );
  await caseEvent(db, caseRow.id, "message_sent", "agent", {
    actionId: action.id,
    channel,
    adapterId,
    preview: body.slice(0, 200),
  });
  // Record REQUESTED only if the outcome hasn't progressed past it — a
  // follow-up send must not regress PROMISED back to REQUESTED.
  const currentOutcome = await latestOutcome(db, caseRow.id);
  if (!currentOutcome || ["REQUESTED", "ACKNOWLEDGED"].includes(currentOutcome.status)) {
    await recordOutcome(db, caseRow.id, "REQUESTED", `Company Service contacted ${companyName}: "${caseRow.desired_outcome}"`, { actor: "agent" });
  }

  const reply = (resultData["merchantReply"] as string | null) ?? null;
  if (reply) {
    await ingestMerchantMessage(env, caseRow, conv, reply);
  } else {
    const cur = await getCase(db, caseRow.id);
    if (cur && cur.status === "IN_PROGRESS") {
      await transitionCase(db, caseRow.id, "WAITING_FOR_COMPANY", { reason: "awaiting merchant reply" });
    }
  }
  return { continue: true };
}

export async function ensureConversation(
  db: D1Database,
  caseId: string,
  channel: string,
  adapterId: string,
): Promise<string> {
  const existing = await q1<{ id: string }>(
    db,
    `SELECT id FROM external_conversations WHERE case_id = ? AND channel = ? AND adapter_id = ? AND status = 'open' LIMIT 1`,
    caseId,
    channel,
    adapterId,
  );
  if (existing) return existing.id;
  const id = newId("conv");
  await run(
    db,
    `INSERT INTO external_conversations (id, case_id, channel, adapter_id) VALUES (?,?,?,?)`,
    id,
    caseId,
    channel,
    adapterId,
  );
  return id;
}

export async function recordMessage(
  db: D1Database,
  conversationId: string,
  direction: "in" | "out",
  subject: string,
  body: string,
  status: string,
  meta?: Record<string, unknown>,
  externalId?: string | null,
): Promise<string> {
  // Two dedup anchors: provider message-id (exact) and content hash (fallback).
  if (externalId) {
    const byId = await q1<{ id: string }>(db, `SELECT id FROM external_messages WHERE external_id = ?`, externalId);
    if (byId) return byId.id;
  }
  const dedup = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${conversationId}:${direction}:${body}`))
    .then((d) => Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join(""));
  const existing = await q1<{ id: string }>(db, `SELECT id FROM external_messages WHERE dedup_hash = ?`, dedup);
  if (existing) return existing.id;
  const id = newId("msg");
  await run(
    db,
    `INSERT INTO external_messages (id, conversation_id, direction, subject, body, meta_json, status, dedup_hash, external_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id,
    conversationId,
    direction,
    subject,
    body,
    JSON.stringify(meta ?? {}),
    status,
    dedup,
    externalId ?? null,
  );
  return id;
}

// ---------------------------------------------------------------------------
// Merchant reply ingestion. The reply is UNTRUSTED: analyzed (not obeyed),
// stored as evidence with provenance, and any offer is gated through policy.
// ---------------------------------------------------------------------------

export async function ingestMerchantMessage(
  env: Env,
  caseRow: CaseRow,
  conversationId: string,
  body: string,
  opts?: { subject?: string; meta?: Record<string, unknown>; externalId?: string | null },
): Promise<void> {
  const db = env.DB;
  await recordMessage(
    db,
    conversationId,
    "in",
    opts?.subject ?? "",
    body,
    "received",
    opts?.meta,
    opts?.externalId,
  );
  await addEvidence(db, env, caseRow.id, {
    kind: "merchant_reply",
    text: body,
    source: "merchant",
    label: "Merchant reply",
  });
  await caseEvent(db, caseRow.id, "message_received", "merchant", { preview: body.slice(0, 200) });

  const analysis = await runModel(env, { userId: caseRow.user_id, caseId: caseRow.id }, {
    role: "light",
    system: SYSTEM_POLICY_PREAMBLE,
    userContext: `TASK:analyze_merchant\nCASE_OBJECTIVE=${caseRow.desired_outcome ?? ""}\nREQUESTED_CENTS=${caseRow.amount_cents ?? ""}`,
    untrustedContent: wrapUntrusted(body, "merchant"),
    responseFormat: "json",
  });
  const parsed = (extractJsonSafe(analysis.text) ?? {}) as {
    intent?: string;
    amountCents?: number | null;
    promiseDays?: number | null;
    offerKind?: string | null;
    injectionDetected?: boolean;
    injectionMatches?: string[];
    deflection?: boolean;
  };

  const heuristic = detectInjection(body);
  if (parsed.injectionDetected || heuristic.detected) {
    await auditEvent(db, {
      userId: caseRow.user_id,
      caseId: caseRow.id,
      type: "prompt_injection_detected",
      severity: "security",
      data: { matches: heuristic.matches, modelFlag: !!parsed.injectionDetected },
    });
    await caseEvent(db, caseRow.id, "injection_blocked", "system", {
      note: "Merchant content contained instruction-like text. It was treated as data only.",
    });
  }

  await addClaim(db, caseRow.id, {
    text: `Merchant stated: ${body.slice(0, 240)}`,
    status: "MERCHANT_STATED",
    sourceType: "merchant",
  });

  const mandate = await getActiveMandate(db, caseRow.id);
  const intent = parsed.intent ?? "other";

  // -------------------------------------------------------------------
  // Deflection layer (M3). Runs on every inbound merchant message,
  // independent of the model's intent label — deterministic detection plus
  // the model's own deflection flag, OR'ed. A denial counts as a hard
  // deflection; a promise past an open promised-date deadline does too.
  // -------------------------------------------------------------------
  const priors = await q<{ body: string }>(
    db,
    `SELECT m.body FROM external_messages m JOIN external_conversations c ON c.id = m.conversation_id
     WHERE c.case_id = ? AND m.direction = 'in' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 6`,
    caseRow.id,
  );
  const priorBodies = priors.map((r) => r.body).slice(1); // [0] is this message
  const det = detectDeflection(body, priorBodies);
  const isDenial = intent === "denial";
  const missedPromise = intent === "promise" ? await hasMissedPromiseDeadline(db, caseRow.id) : false;
  const isDeflection = det.deflection || isDenial || parsed.deflection === true || missedPromise;

  if (isDeflection) {
    const streak = await bumpDeflectionStreak(db, caseRow.id);
    await caseEvent(db, caseRow.id, "deflection_detected", "system", {
      signals: det.signals,
      intent,
      streak,
      modelFlag: parsed.deflection === true,
      pastDeadlinePromise: missedPromise,
    });
    if (isDenial) {
      await recordOutcome(db, caseRow.id, "DENIED", `Merchant denied the request: ${body.slice(0, 200)}`, { actor: "merchant" });
    }
    if (streak >= 2 || isDenial || missedPromise) {
      await resetDeflectionStreak(db, caseRow.id);
      const adv = await advanceRung(
        env,
        caseRow,
        isDenial ? "denial" : missedPromise ? "past-deadline promise" : "consecutive deflections",
      );
      if (!adv) {
        await recordOutcome(db, caseRow.id, "UNRESOLVED", "Escalation ladder exhausted — no further automated rungs.", { actor: "system" });
        await transitionIfAble(db, caseRow.id, "UNRESOLVED", "escalation exhausted");
      }
      return;
    }
    // First deflection — nudge for a substantive answer (a normal follow-up,
    // still inside the mandate; the ladder engages on the second).
    const convN = await replyCount(db, conversationId);
    await proposeAction(
      db,
      caseRow.id,
      "send_followup",
      { body: deflectionNudgeBody(caseRow) },
      `${caseRow.id}:nudge:${convN}`,
    );
    await transitionIfAble(db, caseRow.id, "IN_PROGRESS", "deflection — nudging for a substantive reply");
    return;
  }
  await resetDeflectionStreak(db, caseRow.id);

  switch (intent) {
    case "acknowledgment": {
      await recordOutcome(db, caseRow.id, "ACKNOWLEDGED", "Merchant acknowledged the case.", { actor: "merchant" });
      await transitionIfAble(db, caseRow.id, "WAITING_FOR_COMPANY", "merchant acknowledged");
      await scheduleFollowUp(db, caseRow.id, "check_commitment", addMs(nowIso(), (parsed.promiseDays ?? 1) * 24 * 3600 * 1000));
      break;
    }
    case "promise": {
      const days = parsed.promiseDays ?? 5;
      await recordOutcome(
        db,
        caseRow.id,
        "PROMISED",
        `Merchant stated: outcome promised${parsed.amountCents ? ` ($${(parsed.amountCents / 100).toFixed(2)})` : ""} within ~${days} day(s). Receipt NOT yet verified.`,
        { actor: "merchant" },
      );
      await transitionIfAble(db, caseRow.id, "WAITING_FOR_COMPANY", "promise made — follow-up scheduled");
      await scheduleFollowUp(
        db,
        caseRow.id,
        "check_commitment",
        addMs(nowIso(), Math.max(days, 1) * 24 * 3600 * 1000),
        { expected: "resolution" },
      );
      // The promised date is a tracked deadline, honestly labeled as the
      // merchant's own statement.
      await addDeadline(db, caseRow.id, {
        kind: "promised_date",
        dueAt: addMs(nowIso(), Math.max(days, 1) * 24 * 3600 * 1000),
        source: "MERCHANT_STATED",
        note: `merchant stated ~${days} day(s)`,
      });
      break;
    }
    case "resolution": {
      // Merchant claims issued/completed — still MERCHANT_STATED, not verified.
      await recordOutcome(
        db,
        caseRow.id,
        "ISSUED",
        `Merchant stated the refund/resolution was issued${parsed.amountCents ? ` ($${(parsed.amountCents / 100).toFixed(2)})` : ""}. Customer confirmation still required to mark resolved.`,
        { actor: "merchant" },
      );
      await transitionIfAble(db, caseRow.id, "RESOLUTION_PROPOSED", "merchant claims resolution issued");
      await createApproval(db, caseRow.id, {
        kind: "confirm_receipt",
        summary: `${caseRow.company_name ?? "The merchant"} says the refund/resolution was issued${parsed.amountCents ? ` ($${(parsed.amountCents / 100).toFixed(2)})` : ""}. Have you received it?`,
        detail: { merchantClaim: body.slice(0, 400) },
        options: [
          { id: "received", label: "Yes — received, close the case", kind: "approve" },
          { id: "not_received", label: "Not yet — keep following up", kind: "reject" },
        ],
      });
      await transitionIfAble(db, caseRow.id, "RESOLUTION_PROPOSED", "awaiting customer receipt confirmation");
      break;
    }
    case "offer": {
      const offer = {
        kind: (parsed.offerKind ?? "other") as "money" | "store_credit" | "replacement" | "other",
        amountCents: parsed.amountCents ?? undefined,
        requestedCents: caseRow.amount_cents ?? undefined,
      };
      const decision = classifyMerchantOffer(offer, mandate);
      if (decision.policyClass === "USER_APPROVAL_REQUIRED" || decision.policyClass === "PROHIBITED") {
        await createApproval(db, caseRow.id, {
          kind: "merchant_offer",
          summary: `${caseRow.company_name ?? "Merchant"} offered: ${describeOffer(offer)} — you asked for ${fmtMoney(caseRow.amount_cents)}. ${decision.reason}`,
          detail: { offer, merchantText: body.slice(0, 400) },
          options: [
            { id: "accept", label: `Accept ${describeOffer(offer)}`, kind: "approve" },
            { id: "reject", label: `Reject — keep requesting ${fmtMoney(caseRow.amount_cents)}`, kind: "reject" },
          ],
        });
        await transitionIfAble(db, caseRow.id, "RESOLUTION_PROPOSED", "merchant offer needs customer decision");
      } else {
        // AUTO_ALLOWED acceptance (e.g. full requested amount).
        await recordOutcome(db, caseRow.id, "APPROVED", `Merchant approved the requested outcome: ${describeOffer(offer)}`, { actor: "merchant" });
        await transitionIfAble(db, caseRow.id, "WAITING_FOR_COMPANY", "offer accepted — awaiting issuance");
        await scheduleFollowUp(db, caseRow.id, "check_commitment", addMs(nowIso(), 5 * 24 * 3600 * 1000));
      }
      break;
    }

    case "evidence_request": {
      await transitionIfAble(db, caseRow.id, "WAITING_FOR_CUSTOMER", "merchant requested additional evidence");
      await createApproval(db, caseRow.id, {
        kind: "evidence_request",
        summary: `${caseRow.company_name ?? "Merchant"} is asking for more evidence: ${body.slice(0, 200)}`,
        detail: { merchantText: body.slice(0, 400) },
        options: [
          { id: "provide", label: "I'll add the evidence to this case", kind: "approve" },
          { id: "skip", label: "Can't provide — continue without it", kind: "reject" },
        ],
      });
      break;
    }
    default: {
      await transitionIfAble(db, caseRow.id, "WAITING_FOR_COMPANY", "reply received; no immediate action needed");
      await scheduleFollowUp(db, caseRow.id, "check_commitment", addMs(nowIso(), 2 * 24 * 3600 * 1000));
    }
  }
}

async function replyCount(db: D1Database, conversationId: string): Promise<number> {
  const r = await q1<{ n: number }>(db, `SELECT COUNT(*) AS n FROM external_messages WHERE conversation_id = ?`, conversationId);
  return r?.n ?? 0;
}

function describeOffer(o: { kind: string; amountCents?: number }): string {
  if (o.kind === "store_credit") return o.amountCents ? `$${(o.amountCents / 100).toFixed(2)} store credit` : "store credit";
  if (o.kind === "replacement") return "a replacement";
  if (o.kind === "money") return o.amountCents ? `$${(o.amountCents / 100).toFixed(2)} refund` : "a refund";
  return "an alternative resolution";
}

function fmtMoney(cents: number | null | undefined): string {
  return cents != null ? `$${(cents / 100).toFixed(2)}` : "the requested resolution";
}

async function transitionIfAble(db: D1Database, caseId: string, to: CaseState, reason: string) {
  try {
    await transitionCase(db, caseId, to, { reason });
  } catch {
    // Illegal transitions are non-fatal in ingestion — the state machine stays
    // authoritative; we log and continue.
    await caseEvent(db, caseId, "transition_skipped", "system", { to, reason });
  }
}

// ---------------------------------------------------------------------------
// Durable follow-up sweep — invoked by the cron trigger. For each due item:
// re-check whether the merchant's commitment was fulfilled; if not, send a
// follow-up through the adapter (bounded by mandate); if denied/ignored past
// threshold, escalate.
// ---------------------------------------------------------------------------

export async function runFollowUpSweep(env: Env): Promise<{ fired: number; deadlines?: { warned: number; missed: number } }> {
  // Deadlines first: a missed promised-date advances the escalation ladder,
  // then the new rung's send runs through the normal action loop.
  const deadlines = await runDeadlineSweep(env);
  for (const caseId of deadlines.advanceCaseIds) {
    await advanceCase(env, caseId, "deadline_missed");
  }
  const due = await dueFollowUps(env.DB);
  let fired = 0;
  for (const f of due) {
    const caseRow = await getCase(env.DB, f.case_id);
    if (!caseRow || caseRow.paused || ["RESOLVED", "CANCELLED", "UNRESOLVED", "UNSUPPORTED"].includes(caseRow.status)) {
      await markFired(env.DB, f.id);
      continue;
    }
    const mandate = await getActiveMandate(env.DB, f.case_id);
    if (!mandate) {
      await markFired(env.DB, f.id);
      continue;
    }
    await markFired(env.DB, f.id);
    fired++;

    const outcome = await latestOutcome(env.DB, f.case_id);
    if (outcome && ["RECEIVED", "VERIFIED_RESOLVED", "DENIED", "UNRESOLVED"].includes(outcome.status)) {
      continue;
    }

    await transitionIfAble(env.DB, f.case_id, "FOLLOW_UP_DUE", "follow-up due");
    // Propose a follow-up send; the policy engine re-gates it.
    const key = `${f.case_id}:followup:${f.id}`;
    await proposeAction(env.DB, f.case_id, "send_followup", { followUpId: f.id }, key);
    await transitionIfAble(env.DB, f.case_id, "IN_PROGRESS", "processing follow-up");
    await advanceCase(env, f.case_id, `followup:${f.id}`);
  }
  return { fired, deadlines };
}

// ---------------------------------------------------------------------------
// Post-decision handling: when a customer resolves an approval, continue the
// case according to what they chose.
// ---------------------------------------------------------------------------

export async function handleApprovalDecision(env: Env, approvalId: string): Promise<void> {
  const db = env.DB;
  const row = await q1<{
    id: string; case_id: string; action_id: string | null; kind: string;
    status: string; resolved_option: string | null; options_json: string;
  }>(db, `SELECT * FROM approval_requests WHERE id = ?`, approvalId);
  if (!row || row.status !== "approved" && row.status !== "rejected") return;

  const caseRow = await getCase(db, row.case_id);
  if (!caseRow) return;

  if (row.kind === "confirm_receipt") {
    if (row.resolved_option === "received") {
      await recordOutcome(db, row.case_id, "VERIFIED_RESOLVED", "Customer confirmed receipt. Case closed.", { actor: "customer" });
      await transitionIfAble(db, row.case_id, "RESOLVED", "customer confirmed resolution");
      await cancelFollowUps(db, row.case_id);
    } else {
      await recordOutcome(db, row.case_id, "REQUESTED", "Customer: not received yet — continuing to follow up.", { actor: "customer" });
      await scheduleFollowUp(db, row.case_id, "check_commitment", addMs(nowIso(), 24 * 3600 * 1000));
      await transitionIfAble(db, row.case_id, "WAITING_FOR_COMPANY", "customer has not received resolution");
    }
    return;
  }

  if (row.kind === "merchant_offer") {
    if (row.status === "approved") {
      await recordOutcome(db, row.case_id, "APPROVED", "Customer accepted the merchant's offer.", { actor: "customer" });
      await proposeAction(db, row.case_id, "send_message", { body: "The customer accepts your offer. Please confirm and advise next steps." }, `${row.case_id}:accept-offer:${approvalId}`);
      await transitionIfAble(db, row.case_id, "WAITING_FOR_COMPANY", "offer accepted — awaiting merchant confirmation");
      await advanceCase(env, row.case_id, "approval:offer-accepted");
    } else {
      await recordOutcome(db, row.case_id, "REQUESTED", "Customer declined the offer — continuing to request the original outcome.", { actor: "customer" });
      await proposeAction(db, row.case_id, "send_message", { body: "The customer declines this offer and requests the originally stated resolution." }, `${row.case_id}:reject-offer:${approvalId}`);
      await transitionIfAble(db, row.case_id, "IN_PROGRESS", "offer declined — pursuing original outcome");
      await advanceCase(env, row.case_id, "approval:offer-declined");
    }
    return;
  }

  if (row.kind === "evidence_request") {
    if (row.status === "approved") {
      await transitionIfAble(db, row.case_id, "WAITING_FOR_CUSTOMER", "customer will provide evidence");
    } else {
      await transitionIfAble(db, row.case_id, "IN_PROGRESS", "continuing without additional evidence");
      await advanceCase(env, row.case_id, "approval:evidence-skipped");
    }
    return;
  }

  // action_approval (generic gated action)
  if (row.action_id) {
    if (row.status === "approved") {
      const act = await q1<{ id: string; kind: string; payload_json: string | null }>(
        db,
        `SELECT id, kind, payload_json FROM case_actions WHERE id = ?`,
        row.action_id,
      );
      await run(db, `UPDATE case_actions SET status = 'approved' WHERE id = ?`, row.action_id);
      if (act && (act.kind === "draft_chargeback" || act.kind === "draft_complaint")) {
        // Approving a draft materializes the document — it never sends anything.
        await executeDraftAction(env, caseRow, act);
        await transitionIfAble(db, row.case_id, "WAITING_FOR_CUSTOMER", "draft ready — review it and file it yourself; the system never files on your behalf");
        return;
      }
      await transitionIfAble(db, row.case_id, "IN_PROGRESS", "action approved");
      await advanceCase(env, row.case_id, "approval:action-approved");
    } else {
      await run(db, `UPDATE case_actions SET status = 'rejected' WHERE id = ?`, row.action_id);
      await syncEscalationStatus(db, row.action_id);
      const act = await q1<{ kind: string }>(db, `SELECT kind FROM case_actions WHERE id = ?`, row.action_id);
      if (act && (act.kind === "draft_chargeback" || act.kind === "draft_complaint")) {
        // Declining a draft isn't a resolution — the case just keeps waiting.
        await caseEvent(db, row.case_id, "draft_declined", "customer", { actionId: row.action_id, kind: act.kind });
        await transitionIfAble(db, row.case_id, "WAITING_FOR_COMPANY", "customer declined the draft — continuing with the merchant");
        await scheduleFollowUp(db, row.case_id, "check_commitment", addMs(nowIso(), 2 * 24 * 3600 * 1000));
      } else {
        await recordOutcome(db, row.case_id, "UNRESOLVED", "Customer declined the proposed action.", { actor: "customer" });
      }
    }
  }
}
