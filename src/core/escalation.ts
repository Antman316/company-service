import { addMs, json, newId, nowIso, q, q1, run } from "./db";
import { caseEvent } from "./events";
import { transitionCase } from "./caseEngine";
import { proposeAction } from "./actions";
import { gatherCaseFacts, renderBundleLines, renderChargebackDraft, renderComplaintDrafts } from "./templates";
import { buildPdf } from "./pdf";
import { addEvidence } from "./evidence";
import { recordOutcome } from "./outcomes";
import type { CaseRow } from "./types";

// ---------------------------------------------------------------------------
// Escalation engine (M3). Two halves:
//
//  1) Deflection detection — deterministic signals that a merchant reply is
//     empathy-without-action, a policy wall without citation, or a repeat of
//     an earlier non-answer. The model classifier may also flag deflection;
//     both signals are OR'ed so a weak model can never suppress the ladder.
//
//  2) The rung ladder — per-case progression tracked in `case_escalations`.
//     Rungs 1–4 are outbound sends (policy-gated through the mandate like any
//     other action). Rungs 5–6 are *draft* documents the customer files
//     themselves — always approval-gated, never sent by the system.
//
// Deadlines live in `case_deadlines` with an honest source label:
// CUSTOMER_STATED / MERCHANT_STATED / COMPUTED. Nothing presents a computed
// deadline as authoritative.
// ---------------------------------------------------------------------------

export const MAX_RUNG = 6;

// Action kind per rung. Grants enforced in policy.ts:
//   rung 1 → request_refund    rung 2,3 → request_escalation
//   rung 4 → contact_executive rung 5,6 → always USER_APPROVAL_REQUIRED
export const RUNG_KIND: Record<number, string> = {
  1: "escalate_policy_cite",
  2: "escalate_request_human",
  3: "escalate_supervisor",
  4: "contact_executive",
  5: "draft_chargeback",
  6: "draft_complaint",
};

export const RUNG_LABEL: Record<number, string> = {
  1: "Restate facts + cite merchant policy",
  2: "Request human agent / reference number",
  3: "Request supervisor + explicit deadline",
  4: "Contact executive / corporate relations",
  5: "Draft card-dispute letter (customer files)",
  6: "Draft regulator complaints (customer files)",
};

// ---------------------------------------------------------------------------
// Deflection detection
// ---------------------------------------------------------------------------

const EMPATHY = /(understand how frustrating|sorry for the (inconvenience|frustration|trouble|delay)|apologize for (the|any) (inconvenience|frustration|delay)|completely understand|i (truly )?(hear|understand) (that |you|how))/i;
const NO_ACTION_PHRASES = [
  /nothing (else|more|further) (i|we)( can|'m able to| am able to| are able to|'re able to| cannot| can't) (do|offer|provide)/i,
  /(there is|there's) nothing (else|more|further)/i,
  /unable to (assist|help|offer|provide)( you)?( anything)?( else| more| further)/i,
  /not able to (offer|provide|do|assist|help)( you)?( anything)?( else| more| further)/i,
  /cannot (offer|provide|do|assist|help) (you )?(anything )?(else|more|further)/i,
  /(this|our) (decision|answer|offer) is final|final (answer|decision)/i,
  /beyond (my|our) (control|ability|authority)/i,
];
const POLICY_WALL = /((our|the|company) (returns?|refund|store) policy|not eligible|policy (states|says|does not allow|prevents))(?![^\n]{0,120}(https?:\/\/|section|§|\(quot))/i;
const ACTION_WORDS = /(refund|replacement|reship|re-ship|credit (issued|applied)|issued|processed|approved|shipped|tracking|reference number|case (number|id|ref)|escalat|supervisor|resolv)/i;

export interface DeflectionCheck {
  deflection: boolean;
  signals: string[];
}

function tokenSet(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3),
  );
}

function isRepeat(body: string, priors: string[]): boolean {
  const t = tokenSet(body);
  if (t.size === 0) return false;
  for (const p of priors) {
    const s = tokenSet(p);
    if (s.size === 0) continue;
    let inter = 0;
    for (const w of t) if (s.has(w)) inter++;
    if (inter / (t.size + s.size - inter) >= 0.7) return true;
  }
  return false;
}

export function detectDeflection(body: string, priorBodies: string[] = []): DeflectionCheck {
  const signals: string[] = [];
  if (EMPATHY.test(body) && !ACTION_WORDS.test(body)) signals.push("empathy_without_action");
  if (NO_ACTION_PHRASES.some((re) => re.test(body))) signals.push("no_action_phrase");
  if (POLICY_WALL.test(body)) signals.push("policy_wall_without_citation");
  if (isRepeat(body, priorBodies)) signals.push("repeat_non_answer");
  return { deflection: signals.length > 0, signals };
}

// ---------------------------------------------------------------------------
// Deflection streak — stored on cases.meta.escalation (durable, no extra rows)
// ---------------------------------------------------------------------------

async function readStreak(db: D1Database, caseId: string): Promise<number> {
  // Read fresh — the caller's CaseRow may be stale mid-loop.
  const row = await q1<{ meta: string | null }>(db, `SELECT meta FROM cases WHERE id = ?`, caseId);
  return json<{ escalation?: { streak?: number } }>(row?.meta ?? null, {}).escalation?.streak ?? 0;
}

async function writeStreak(db: D1Database, caseId: string, n: number): Promise<void> {
  await run(
    db,
    `UPDATE cases SET meta = json_set(COALESCE(meta,'{}'), '$.escalation.streak', ?), updated_at = ? WHERE id = ?`,
    n,
    nowIso(),
    caseId,
  );
}

export async function bumpDeflectionStreak(db: D1Database, caseId: string): Promise<number> {
  const n = (await readStreak(db, caseId)) + 1;
  await writeStreak(db, caseId, n);
  return n;
}

export async function resetDeflectionStreak(db: D1Database, caseId: string): Promise<void> {
  if ((await readStreak(db, caseId)) !== 0) await writeStreak(db, caseId, 0);
}

export function deflectionNudgeBody(caseRow: CaseRow): string {
  return [
    `Hello ${caseRow.company_name ?? "support"} — following up on this case.`,
    ``,
    `Your previous reply did not include a resolution, a timeline, or next steps.`,
    `The customer's request stands: ${caseRow.desired_outcome ?? "resolve this issue"}.`,
    `Please respond with a substantive answer and a case or reference number.`,
    ``,
    `(Sent by Company Service — an AI representative authorized by the customer.)`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Merchant playbooks (rung-1 policy citation + rung-4 executive contact)
// ---------------------------------------------------------------------------

export interface Playbook {
  company_id: string;
  support_email: string | null;
  chat_url: string | null;
  executive_contact: string | null;
  return_window_days: number | null;
  policy_url: string | null;
  policy_quotes: string[];
}

export async function getPlaybook(db: D1Database, companyId: string | null): Promise<Playbook | null> {
  if (!companyId) return null;
  const r = await q1<Record<string, unknown>>(
    db,
    `SELECT * FROM merchant_playbooks WHERE company_id = ? ORDER BY version DESC LIMIT 1`,
    companyId,
  );
  if (!r) return null;
  return {
    company_id: r.company_id as string,
    support_email: (r.support_email as string) ?? null,
    chat_url: (r.chat_url as string) ?? null,
    executive_contact: (r.executive_contact as string) ?? null,
    return_window_days: (r.return_window_days as number) ?? null,
    policy_url: (r.policy_url as string) ?? null,
    policy_quotes: json<string[]>(r.policy_quotes as string | null, []),
  };
}

// ---------------------------------------------------------------------------
// Rung bodies — fixed templates, deterministic, no model involvement.
// ---------------------------------------------------------------------------

function fmtAmount(caseRow: CaseRow): string {
  return caseRow.amount_cents != null
    ? `$${(caseRow.amount_cents / 100).toFixed(2)} ${caseRow.currency ?? "USD"}`
    : "the amount in question";
}

function businessDaysFromNow(days: number): string {
  const d = new Date();
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

async function rungBody(env: Env, caseRow: CaseRow, rung: number): Promise<string> {
  const meta = json<{ orderRef?: string }>(caseRow.meta, {});
  const order = meta.orderRef ? ` (order ${meta.orderRef})` : "";
  const what = caseRow.desired_outcome ?? "the requested resolution";
  const playbook = await getPlaybook(env.DB, caseRow.company_id);
  switch (rung) {
    case 1: {
      const cite = playbook?.policy_url || playbook?.policy_quotes.length
        ? ` Your published policy${playbook.policy_url ? ` (${playbook.policy_url})` : ""} states: "${playbook.policy_quotes[0] ?? "see policy page"}". This request is consistent with that policy.`
        : ` Please cite the specific published policy provision your team is relying on so the customer can review it.`;
      return [
        `Hello ${caseRow.company_name} support,`,
        ``,
        `Restating the customer's request for the record${order}: ${what}, ${fmtAmount(caseRow)}.`,
        cite,
        `Please confirm how this will be resolved and provide a case or reference number.`,
        ``,
        `(Sent by Company Service — an AI representative authorized by the customer.)`,
      ].join("\n");
    }
    case 2:
      return [
        `Hello ${caseRow.company_name} support,`,
        ``,
        `This matter${order} remains unresolved after multiple contacts. Please connect the customer with a human agent, and provide:`,
        `1) a case or reference number, and`,
        `2) written confirmation of the next steps and expected timeline.`,
        ``,
        `Requested resolution: ${what} (${fmtAmount(caseRow)}).`,
        ``,
        `(Sent by Company Service — an AI representative authorized by the customer.)`,
      ].join("\n");
    case 3:
      return [
        `Hello ${caseRow.company_name} support,`,
        ``,
        `Please escalate this case${order} to a supervisor or your escalations/resolutions team.`,
        `If we do not receive a substantive response by ${businessDaysFromNow(5)} (5 business days), the customer will proceed with their remaining options, including a dispute with their card issuer.`,
        `Requested resolution: ${what} (${fmtAmount(caseRow)}).`,
        ``,
        `(Sent by Company Service — an AI representative authorized by the customer.)`,
      ].join("\n");
    case 4:
      return [
        `Dear ${caseRow.company_name} executive customer-relations team,`,
        ``,
        `Escalation on behalf of a customer${order}: ${what} (${fmtAmount(caseRow)}).`,
        `Front-line support has been unable to resolve this after multiple attempts. We are asking your office to review the case and respond within 5 business days.`,
        ``,
        `(Sent by Company Service — an AI representative authorized by the customer.)`,
      ].join("\n");
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// advanceRung — propose the next rung's action and track it.
// ---------------------------------------------------------------------------

export async function currentRung(db: D1Database, caseId: string): Promise<number> {
  const r = await q1<{ m: number | null }>(
    db,
    `SELECT MAX(rung) AS m FROM case_escalations WHERE case_id = ? AND status != 'skipped'`,
    caseId,
  );
  return r?.m ?? 0;
}

export async function syncEscalationStatus(db: D1Database, actionId: string): Promise<void> {
  await run(
    db,
    `UPDATE case_escalations SET status = (SELECT status FROM case_actions WHERE id = ?) WHERE action_id = ?`,
    actionId,
    actionId,
  );
}

// Materialize an approved rungs-5/6 draft: the rendered letter + a generated
// evidence-bundle PDF land in case_evidence; the action is marked executed.
// This never sends anything — the customer files the documents themselves.
export async function executeDraftAction(
  env: Env,
  caseRow: CaseRow,
  action: { id: string; kind: string; payload_json: string | null },
): Promise<void> {
  const db = env.DB;
  const facts = await gatherCaseFacts(db, caseRow);
  const payload = json<{ draft?: string; drafts?: { agency: string; url: string; body: string }[] }>(
    action.payload_json,
    {},
  );
  let draftEvidenceId: string | null = null;
  if (action.kind === "draft_chargeback") {
    const text = payload.draft ?? renderChargebackDraft(facts);
    draftEvidenceId = await addEvidence(db, env, caseRow.id, {
      kind: "note",
      text,
      source: "system",
      label: "Card-dispute letter draft — customer files with their card issuer",
    });
  } else if (action.kind === "draft_complaint") {
    const drafts = payload.drafts ?? renderComplaintDrafts(facts);
    const text = drafts.map((d) => `=== ${d.agency} ===\nFile at: ${d.url}\n\n${d.body}`).join("\n\n---\n\n");
    draftEvidenceId = await addEvidence(db, env, caseRow.id, {
      kind: "note",
      text,
      source: "system",
      label: "Regulator complaint drafts — customer files them",
    });
  }
  const msgs = await q<{ direction: string; channel: string; subject: string; body: string; created_at: string }>(
    db,
    `SELECT m.direction, c.channel, m.subject, m.body, m.created_at FROM external_messages m
     JOIN external_conversations c ON c.id = m.conversation_id WHERE c.case_id = ? ORDER BY m.created_at ASC`,
    caseRow.id,
  );
  const pdf = buildPdf(
    `Case ${caseRow.id} evidence bundle`,
    renderBundleLines(facts, msgs.map((m) => ({ direction: m.direction, channel: m.channel, subject: m.subject, body: m.body, at: m.created_at }))),
  );
  const bundleId = await addEvidence(db, env, caseRow.id, {
    kind: "pdf",
    blob: pdf,
    mime: "application/pdf",
    source: "system",
    label: "Evidence bundle (generated)",
  });
  await run(
    db,
    `UPDATE case_actions SET status='executed', executed_at=?, result_json=? WHERE id=?`,
    nowIso(),
    JSON.stringify({ draftEvidenceId, bundleEvidenceId: bundleId, documentKind: action.kind }),
    action.id,
  );
  await syncEscalationStatus(db, action.id);
  await caseEvent(db, caseRow.id, "draft_ready", "system", {
    actionId: action.id,
    kind: action.kind,
    draftEvidenceId,
    bundleEvidenceId: bundleId,
    note: "Document rendered from case records only — customer files it themselves.",
  });
}

export async function advanceRung(
  env: Env,
  caseRow: CaseRow,
  reason: string,
): Promise<{ rung: number; actionId: string | null } | null> {
  const db = env.DB;
  let rung = (await currentRung(db, caseRow.id)) + 1;

  // Rung 4 needs a playbook executive contact; skip straight to 5 when absent.
  if (rung === 4) {
    const playbook = await getPlaybook(db, caseRow.company_id);
    if (!playbook?.executive_contact) {
      await run(
        db,
        `INSERT OR IGNORE INTO case_escalations (id, case_id, rung, action_id, status, note) VALUES (?,?,?,?,?,?)`,
        newId("esc"),
        caseRow.id,
        4,
        null,
        "skipped",
        "no executive contact on file",
      );
      await caseEvent(db, caseRow.id, "rung_skipped", "system", { rung: 4, reason: "no executive contact on file" });
      rung = 5;
    }
  }

  if (rung > MAX_RUNG) {
    await caseEvent(db, caseRow.id, "escalation_exhausted", "system", { reason });
    return null;
  }

  const kind = RUNG_KIND[rung]!;
  const payload: Record<string, unknown> = { rung };
  if (rung === 5) {
    // Rendered at proposal time so the approval card shows the actual document
    // the customer would file — template-only, no model or merchant text in.
    payload.draft = renderChargebackDraft(await gatherCaseFacts(db, caseRow));
  } else if (rung === 6) {
    payload.drafts = renderComplaintDrafts(await gatherCaseFacts(db, caseRow));
  }
  if (rung <= 4) {
    payload.body = await rungBody(env, caseRow, rung);
    if (rung === 4) {
      const playbook = await getPlaybook(db, caseRow.company_id);
      payload.to = playbook!.executive_contact;
    }
    if (rung === 3) {
      // Supervisor-response deadline: computed (5 business days), honestly labeled.
      await addDeadline(db, caseRow.id, {
        kind: "supervisor_response",
        dueAt: `${businessDaysFromNow(5)}T23:59:59Z`,
        source: "COMPUTED",
        note: "5-business-day deadline set in supervisor escalation",
      });
    }
  }

  const actionId = await proposeAction(db, caseRow.id, kind, payload, `${caseRow.id}:rung:${rung}`);
  await run(
    db,
    `INSERT OR IGNORE INTO case_escalations (id, case_id, rung, action_id, status, note) VALUES (?,?,?,?,?,?)`,
    newId("esc"),
    caseRow.id,
    rung,
    actionId,
    "proposed",
    reason,
  );
  await caseEvent(db, caseRow.id, "rung_advanced", "system", {
    rung,
    kind,
    reason,
    label: RUNG_LABEL[rung],
  });
  try {
    await transitionCase(db, caseRow.id, "ESCALATION_REQUIRED", { reason: `rung ${rung}: ${RUNG_LABEL[rung]} — ${reason}` });
    await transitionCase(db, caseRow.id, "IN_PROGRESS", { reason: "executing escalation rung" });
  } catch {
    // Illegal transitions are non-fatal — the state machine stays authoritative.
  }
  return { rung, actionId };
}

// ---------------------------------------------------------------------------
// Deadline tracker
// ---------------------------------------------------------------------------

export type DeadlineSource = "CUSTOMER_STATED" | "MERCHANT_STATED" | "COMPUTED";
export type DeadlineKind =
  | "promised_date"
  | "return_window"
  | "chargeback_window"
  | "supervisor_response"
  | "complaint_window";

export async function addDeadline(
  db: D1Database,
  caseId: string,
  input: { kind: DeadlineKind; dueAt: string; source: DeadlineSource; note?: string },
): Promise<string | null> {
  // Dedupe identical entries; a new promise supersedes an open one of the same kind.
  const existing = await q1<{ id: string }>(
    db,
    `SELECT id FROM case_deadlines WHERE case_id = ? AND kind = ? AND due_at = ? LIMIT 1`,
    caseId,
    input.kind,
    input.dueAt,
  );
  if (existing) return existing.id;
  if (input.kind === "promised_date") {
    await run(
      db,
      `UPDATE case_deadlines SET status = 'cancelled' WHERE case_id = ? AND kind = 'promised_date' AND status = 'open'`,
      caseId,
    );
  }
  const id = newId("dl");
  await run(
    db,
    `INSERT INTO case_deadlines (id, case_id, kind, due_at, source, status, note) VALUES (?,?,?,?,?,'open',?)`,
    id,
    caseId,
    input.kind,
    input.dueAt,
    input.source,
    input.note ?? null,
  );
  await caseEvent(db, caseId, "deadline_created", "system", {
    deadlineId: id,
    kind: input.kind,
    dueAt: input.dueAt,
    source: input.source,
  });
  return id;
}

export async function hasMissedPromiseDeadline(db: D1Database, caseId: string): Promise<boolean> {
  const r = await q1<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM case_deadlines WHERE case_id = ? AND kind = 'promised_date' AND status = 'open' AND due_at < ?`,
    caseId,
    nowIso(),
  );
  return (r?.n ?? 0) > 0;
}

// Cron sweep — surfaces deadlines 7 and 2 days out, marks misses, and drives
// "one past-deadline promise → next rung". Missed dates that advance the
// ladder are returned in `advanceCaseIds` — the CALLER runs advanceCase on
// them (agent.ts owns the action loop; importing it here would be circular).
export async function runDeadlineSweep(env: Env): Promise<{ warned: number; missed: number; advanceCaseIds: string[] }> {
  const horizon7 = addMs(nowIso(), 7 * 24 * 3600 * 1000);
  const open = await q<{
    id: string; case_id: string; kind: string; due_at: string; source: string;
    notified_7d: number; notified_2d: number;
  }>(
    env.DB,
    `SELECT id, case_id, kind, due_at, source, notified_7d, notified_2d FROM case_deadlines
     WHERE status = 'open' AND due_at <= ?`,
    horizon7,
  );
  let warned = 0;
  let missed = 0;
  const advanceCaseIds = new Set<string>();
  const now = nowIso();
  for (const d of open) {
    const caseRow = await q1<CaseRow>(env.DB, `SELECT * FROM cases WHERE id = ?`, d.case_id);
    if (!caseRow || caseRow.paused || ["RESOLVED", "CANCELLED", "UNRESOLVED", "UNSUPPORTED"].includes(caseRow.status)) {
      await run(env.DB, `UPDATE case_deadlines SET status = 'cancelled' WHERE id = ?`, d.id);
      continue;
    }
    if (d.due_at < now) {
      await run(env.DB, `UPDATE case_deadlines SET status = 'missed' WHERE id = ?`, d.id);
      await caseEvent(env.DB, d.case_id, "deadline_missed", "system", {
        deadlineId: d.id, kind: d.kind, dueAt: d.due_at, source: d.source,
      });
      missed++;
      if (d.kind === "promised_date" || d.kind === "supervisor_response") {
        const adv = await advanceRung(env, caseRow, `missed ${d.kind.replace(/_/g, " ")} deadline`);
        if (adv) advanceCaseIds.add(d.case_id);
        if (!adv) {
          await recordOutcome(env.DB, d.case_id, "UNRESOLVED", "Escalation ladder exhausted after missed deadline.", { actor: "system" });
          try {
            await transitionCase(env.DB, d.case_id, "UNRESOLVED", { reason: "escalation exhausted" });
          } catch { /* state machine stays authoritative */ }
        }
      }
      continue;
    }
    const horizon2 = addMs(now, 2 * 24 * 3600 * 1000);
    if (d.due_at <= horizon2 && !d.notified_2d) {
      await run(env.DB, `UPDATE case_deadlines SET notified_2d = 1 WHERE id = ?`, d.id);
      await caseEvent(env.DB, d.case_id, "deadline_approaching", "system", {
        deadlineId: d.id, kind: d.kind, dueAt: d.due_at, source: d.source, window: "2d",
      });
      warned++;
    } else if (!d.notified_7d) {
      await run(env.DB, `UPDATE case_deadlines SET notified_7d = 1 WHERE id = ?`, d.id);
      await caseEvent(env.DB, d.case_id, "deadline_approaching", "system", {
        deadlineId: d.id, kind: d.kind, dueAt: d.due_at, source: d.source, window: "7d",
      });
      warned++;
    }
  }
  return { warned, missed, advanceCaseIds: [...advanceCaseIds] };
}
