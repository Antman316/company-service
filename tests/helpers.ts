import { env, SELF } from "cloudflare:test";

// End-to-end helpers driving the real HTTP surface with a signed-in session.

export interface TestClient {
  cookie: string;
  csrf: string;
  userId?: string;
}

export async function signup(email: string, password = "password-1234"): Promise<TestClient> {
  const r = await SELF.fetch("http://test/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`signup failed: ${r.status} ${await r.text()}`);
  const setCookie = r.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0]!;
  const body = (await r.json()) as { csrf: string };
  return { cookie, csrf: body.csrf };
}

export function authed(c: TestClient, extra: Record<string, string> = {}) {
  return {
    Cookie: c.cookie,
    "x-csrf": c.csrf,
    "Content-Type": "application/json",
    ...extra,
  };
}

export async function apiGet(c: TestClient, path: string) {
  const r = await SELF.fetch(`http://test${path}`, { headers: authed(c) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

export async function apiPost(c: TestClient, path: string, body: unknown = {}) {
  const r = await SELF.fetch(`http://test${path}`, {
    method: "POST",
    headers: authed(c),
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

export async function createTestCase(
  c: TestClient,
  text: string,
  scenario?: string,
): Promise<string> {
  const r = await apiPost(c, "/api/cases", { text, scenario });
  if (r.status !== 200) throw new Error(`create case failed: ${JSON.stringify(r.body)}`);
  // Point the case at the deterministic test merchant company.
  await env.DB.prepare(`UPDATE cases SET company_id = 'cmp_testmerchant', company_name = 'Test Merchant' WHERE id = ?`)
    .bind(r.body.caseId)
    .run();
  return r.body.caseId as string;
}

export async function grantMandate(c: TestClient, caseId: string) {
  const r = await apiPost(c, `/api/cases/${caseId}/mandate`, {
    authorized: [
      "contact_company", "request_refund", "share_order_number",
      "share_tracking_number", "share_evidence", "follow_up", "request_escalation",
      "contact_executive",
    ],
    approvalRequired: [
      "accept_partial_refund", "accept_store_credit", "accept_replacement",
      "agree_to_fee", "change_delivery", "accept_new_terms", "close_case_satisfied",
    ],
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  });
  if (r.status !== 200) throw new Error(`mandate failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function getCaseDetail(c: TestClient, caseId: string) {
  const r = await apiGet(c, `/api/cases/${caseId}`);
  if (r.status !== 200) throw new Error(`case detail failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function forceFollowUpDue(caseId: string) {
  await env.DB.prepare(
    `UPDATE follow_ups SET due_at = '2000-01-01T00:00:00Z' WHERE case_id = ? AND status = 'pending'`,
  ).bind(caseId).run();
}

export async function forceDeadlineDue(caseId: string, kind?: string) {
  await env.DB.prepare(
    `UPDATE case_deadlines SET due_at = '2000-01-01T00:00:00Z' WHERE case_id = ? AND status = 'open' ${kind ? "AND kind = ?" : ""}`,
  ).bind(...(kind ? [caseId, kind] : [caseId])).run();
}

export async function dbAll<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
  const r = await env.DB.prepare(sql).bind(...binds).all();
  return (r.results ?? []) as T[];
}

export async function dbOne<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null> {
  const r = await env.DB.prepare(sql).bind(...binds).first();
  return (r ?? null) as T | null;
}
