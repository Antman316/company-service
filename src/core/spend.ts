import { json, q1 } from "./db";

// ---------------------------------------------------------------------------
// Abuse/cost gate (amended spec §M1 + §11): before ANY non-local model call —
//  - the account email must be verified;
//  - the per-case soft cap must be under budget (pause + approval to continue);
//  - per-user daily and global daily caps must be under budget (hard stop).
// local_dev is exempt: it costs nothing and never leaves the machine.
// Caps are env-tunable (plain_text bindings, micro-USD integers).
// ---------------------------------------------------------------------------

export class SpendCapError extends Error {
  scope: "case" | "user" | "global" | "unverified";
  spentMicroUsd: number;
  capMicroUsd: number;
  constructor(scope: SpendCapError["scope"], spentMicroUsd: number, capMicroUsd: number) {
    super(`spend cap hit: ${scope}`);
    this.scope = scope;
    this.spentMicroUsd = spentMicroUsd;
    this.capMicroUsd = capMicroUsd;
  }
}

const DEFAULTS = {
  caseMicroUsd: 500_000,        // $0.50 per case — soft cap, continue via approval
  userDailyMicroUsd: 5_000_000, // $5 per user per day — hard stop
  globalDailyMicroUsd: 100_000_000, // $100 across the platform per day — hard stop
};

function intEnv(v: string | undefined, dflt: number): number {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export async function spendGate(
  env: Env,
  ctx: { userId: string; caseId?: string },
  isLocal: boolean,
): Promise<void> {
  if (isLocal) return;

  const user = await q1<{ email_verified_at: string | null }>(
    env.DB,
    `SELECT email_verified_at FROM users WHERE id = ?`,
    ctx.userId,
  );
  if (!user?.email_verified_at) throw new SpendCapError("unverified", 0, 0);

  const today = new Date().toISOString().slice(0, 10);

  if (ctx.caseId) {
    const caseCap = intEnv(env.CASE_SPEND_CAP_MICRO_USD, DEFAULTS.caseMicroUsd);
    // A 'spend_cap_continue' approval raises the ceiling — stored in case meta
    // so it survives deploys and stays attributable to a customer decision.
    const row = await q1<{ spent: number | null; meta: string | null }>(
      env.DB,
      `SELECT (SELECT COALESCE(SUM(cost_micro_usd),0) FROM cost_events WHERE case_id = ?) AS spent,
              (SELECT meta FROM cases WHERE id = ?) AS meta`,
      ctx.caseId,
      ctx.caseId,
    );
    const extra = json<{ spend_cap_extra?: number }>(row?.meta ?? null, {}).spend_cap_extra ?? 0;
    const spent = row?.spent ?? 0;
    if (spent >= caseCap + extra) throw new SpendCapError("case", spent, caseCap + extra);
  }

  const userCap = intEnv(env.USER_DAILY_SPEND_CAP_MICRO_USD, DEFAULTS.userDailyMicroUsd);
  const userRow = await q1<{ spent: number | null }>(
    env.DB,
    `SELECT COALESCE(SUM(ce.cost_micro_usd),0) AS spent
     FROM cost_events ce JOIN cases c ON c.id = ce.case_id
     WHERE c.user_id = ? AND ce.created_at >= ?`,
    ctx.userId,
    `${today}T00:00:00`,
  );
  if ((userRow?.spent ?? 0) >= userCap) throw new SpendCapError("user", userRow?.spent ?? 0, userCap);

  const globalCap = intEnv(env.GLOBAL_DAILY_SPEND_CAP_MICRO_USD, DEFAULTS.globalDailyMicroUsd);
  const globalRow = await q1<{ spent: number | null }>(
    env.DB,
    `SELECT COALESCE(SUM(cost_micro_usd),0) AS spent FROM cost_events WHERE created_at >= ?`,
    `${today}T00:00:00`,
  );
  if ((globalRow?.spent ?? 0) >= globalCap) throw new SpendCapError("global", globalRow?.spent ?? 0, globalCap);
}

// Raise a case's soft-cap ceiling after a customer 'continue' decision.
export async function bumpCaseSpendCap(db: D1Database, caseId: string, extraMicroUsd: number): Promise<void> {
  const row = await q1<{ meta: string | null }>(db, `SELECT meta FROM cases WHERE id = ?`, caseId);
  const meta = json<{ spend_cap_extra?: number }>(row?.meta ?? null, {});
  const next = (meta.spend_cap_extra ?? 0) + extraMicroUsd;
  await db
    .prepare(`UPDATE cases SET meta = json_set(COALESCE(meta,'{}'), '$.spend_cap_extra', ?) WHERE id = ?`)
    .bind(next, caseId)
    .run();
}
