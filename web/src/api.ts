// API client — cookie session + CSRF header on mutations.

let csrfToken: string | null = null;
export function setCsrf(t: string | null) { csrfToken = t; }

async function req<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as any) };
  if (opts.method && opts.method !== "GET") {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    if (csrfToken) headers["x-csrf"] = csrfToken;
  }
  const r = await fetch(path, { ...opts, headers, credentials: "same-origin" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (body as any)?.error ?? `HTTP ${r.status}`);
  return body as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const api = {
  me: () => req<{ user: { id: string; email: string } | null; csrf: string }>("/api/auth/me"),
  signup: (email: string, password: string) =>
    req<{ ok: boolean; csrf: string }>("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }),
  signin: (email: string, password: string) =>
    req<{ ok: boolean; csrf: string }>("/api/auth/signin", { method: "POST", body: JSON.stringify({ email, password }) }),
  signout: () => req("/api/auth/signout", { method: "POST" }),

  listCases: () => req<{ cases: any[]; pendingApprovals: number }>("/api/cases"),
  createCase: (text: string, scenario?: string) =>
    req<{ caseId: string; objective: any; suggestedMandate: any }>(
      "/api/cases", { method: "POST", body: JSON.stringify({ text, scenario }) }),
  caseDetail: (id: string) => req<any>(`/api/cases/${id}`),
  addEvidence: (id: string, b: { kind?: string; text?: string; label?: string }) =>
    req(`/api/cases/${id}/evidence`, { method: "POST", body: JSON.stringify(b) }),
  uploadEvidence: async (id: string, file: File, kind = "receipt") => {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    const r = await fetch(`/api/cases/${id}/evidence`, {
      method: "POST", body: form, credentials: "same-origin",
      headers: csrfToken ? { "x-csrf": csrfToken } : {},
    });
    if (!r.ok) throw new ApiError(r.status, "upload failed");
    return r.json();
  },
  grantMandate: (id: string, m: { authorized: string[]; approvalRequired: string[]; prohibited?: string[]; expiresAt?: string }) =>
    req(`/api/cases/${id}/mandate`, { method: "POST", body: JSON.stringify(m) }),
  revokeMandate: (id: string) => req(`/api/cases/${id}/mandate/revoke`, { method: "POST" }),
  pauseCase: (id: string) => req(`/api/cases/${id}/pause`, { method: "POST" }),
  resumeCase: (id: string) => req(`/api/cases/${id}/resume`, { method: "POST" }),
  cancelCase: (id: string) => req(`/api/cases/${id}/cancel`, { method: "POST" }),
  runCase: (id: string) => req(`/api/cases/${id}/run`, { method: "POST" }),
  addNote: (id: string, text: string) => req(`/api/cases/${id}/message`, { method: "POST", body: JSON.stringify({ text }) }),

  approvals: () => req<{ approvals: any[] }>("/api/approvals"),
  decide: (id: string, optionId: string) =>
    req(`/api/approvals/${id}/decide`, { method: "POST", body: JSON.stringify({ optionId }) }),

  connections: () => req<{ connections: any[] }>("/api/connections"),
  addConnection: (b: { type: string; provider: string; label: string; config?: Record<string, string> }) =>
    req("/api/connections", { method: "POST", body: JSON.stringify(b) }),
  removeConnection: (id: string) => req(`/api/connections/${id}`, { method: "DELETE" }),
  testConnection: (id: string) => req(`/api/connections/${id}/test`, { method: "POST" }),

  coverage: () => req<{ companies: any[]; coverage: any[] }>("/api/coverage"),
  economics: () => req<any>("/api/economics"),
};

export function money(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "—";
  return `${(cents / 100).toLocaleString("en-US", { style: "currency", currency })}`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function statusTone(status: string): "green" | "amber" | "red" | "blue" | "" {
  switch (status) {
    case "RESOLVED": case "VERIFIED_RESOLVED": return "green";
    case "UNRESOLVED": case "UNSUPPORTED": case "CANCELLED": case "DENIED": return "red";
    case "WAITING_FOR_COMPANY": case "IN_PROGRESS": case "FOLLOW_UP_DUE": case "PLANNING": return "blue";
    case "WAITING_FOR_CUSTOMER": case "AWAITING_AUTHORIZATION": case "NEEDS_INFORMATION": case "RESOLUTION_PROPOSED": case "ESCALATION_REQUIRED": return "amber";
    default: return "";
  }
}

export const EVENT_LABELS: Record<string, string> = {
  case_created: "Case created",
  intake_completed: "Problem understood",
  evidence_added: "Evidence added",
  mandate_drafted: "Mandate drafted",
  mandate_activated: "You authorized your agent",
  mandate_revoked: "Authority revoked",
  mandate_expired: "Mandate expired",
  agent_cycle_start: "Agent checked in",
  plan_created: "Plan created",
  action_classified: "Action policy-checked",
  action_prohibited: "Action blocked by policy",
  action_failed: "Action failed",
  message_sent: "Message sent to company",
  message_received: "Company replied",
  outcome_update: "Outcome update",
  followup_scheduled: "Follow-up scheduled",
  approval_created: "Needs your decision",
  approval_decided: "You decided",
  state_change: "Status changed",
  transition_skipped: "State note",
  injection_blocked: "Injection attempt blocked",
  manual_handoff: "Manual handoff",
  customer_note: "You added a note",
  case_paused: "Case paused",
  case_resumed: "Case resumed",
  cycle_skipped: "Cycle skipped",
};
