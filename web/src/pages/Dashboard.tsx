import { useEffect, useState } from "react";
import { api, fmtTime, money, statusTone } from "../api";

const ATTENTION = new Set(["WAITING_FOR_CUSTOMER", "AWAITING_AUTHORIZATION", "RESOLUTION_PROPOSED", "NEEDS_INFORMATION", "ESCALATION_REQUIRED"]);

export function Dashboard({ nav, me }: { nav: (to: string) => void; me: { email: string } }) {
  const [data, setData] = useState<{ cases: any[]; pendingApprovals: number } | null>(null);

  useEffect(() => {
    api.listCases().then(setData).catch(() => setData({ cases: [], pendingApprovals: 0 }));
  }, []);

  const cases = data?.cases ?? [];
  const attention = cases.filter((c) => ATTENTION.has(c.status) || c.paused);
  const active = cases.filter((c) => !ATTENTION.has(c.status) && !["RESOLVED", "UNRESOLVED", "CANCELLED", "UNSUPPORTED"].includes(c.status));
  const done = cases.filter((c) => ["RESOLVED", "UNRESOLVED", "CANCELLED", "UNSUPPORTED"].includes(c.status));

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div>
          <h1 style={{ margin: 0, letterSpacing: "-.02em" }}>Your cases</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>{me.email}</p>
        </div>
        <button className="btn btn-primary" onClick={() => nav("/new")}>+ New case</button>
      </div>

      {data === null ? (
        <div className="empty"><span className="spinner" /></div>
      ) : cases.length === 0 ? (
        <div className="empty" style={{ marginTop: 30 }}>
          <div className="big">Start your first case</div>
          <p>Two ways in:</p>
          <div className="grid grid-2" style={{ textAlign: "left", marginTop: 14 }}>
            <div className="card" style={{ padding: 18 }}>
              <strong>Forward a merchant email</strong>
              <p className="small muted" style={{ margin: "6px 0 10px" }}>
                Got a shipping notice, refund denial, or stonewall in your inbox? Forward it to{" "}
                <strong>case+new@agentmasterkey.com</strong> — it becomes a case automatically.
              </p>
              <span className="small muted">(Works after your email is verified.)</span>
            </div>
            <div className="card" style={{ padding: 18 }}>
              <strong>Describe the problem</strong>
              <p className="small muted" style={{ margin: "6px 0 10px" }}>
                A missing refund, wrong item, damaged delivery — say it in a sentence and the agent takes it from there.
              </p>
              <button className="btn btn-primary" onClick={() => nav("/new")}>Type it out</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {attention.length > 0 && (
            <>
              <div className="section-title">Needs your attention</div>
              {attention.map((c) => <CaseRow key={c.id} c={c} nav={nav} />)}
            </>
          )}
          {active.length > 0 && (
            <>
              <div className="section-title">In progress</div>
              {active.map((c) => <CaseRow key={c.id} c={c} nav={nav} />)}
            </>
          )}
          {done.length > 0 && (
            <>
              <div className="section-title">Closed</div>
              {done.map((c) => <CaseRow key={c.id} c={c} nav={nav} />)}
            </>
          )}
        </>
      )}

      <div className="card" style={{ marginTop: 28 }}>
        <div className="section-title" style={{ marginTop: 0 }}>Your data</div>
        <p className="small muted">
          Everything Company Service holds about you — cases, evidence, messages, connections.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="btn btn-sm" href="/api/account/export" target="_blank" rel="noreferrer">Export my data</a>
          <DeleteAccount />
        </div>
      </div>
    </div>
  );
}

function DeleteAccount() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!confirming) {
    return <button className="btn btn-sm btn-ghost" onClick={() => setConfirming(true)}>Delete my account</button>;
  }
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <span className="small" style={{ color: "var(--red)" }}>Deletes cases, evidence, messages, connections — cannot be undone.</span>
      <button className="btn btn-sm btn-danger" disabled={busy} onClick={async () => {
        setBusy(true);
        try { await api.deleteAccount(); window.location.href = "#/"; window.location.reload(); }
        catch (e: any) { setErr(e.message); setBusy(false); }
      }}>Confirm delete</button>
      <button className="btn btn-sm btn-ghost" onClick={() => setConfirming(false)}>Keep account</button>
      {err && <span className="small" style={{ color: "var(--red)" }}>{err}</span>}
    </span>
  );
}

function CaseRow({ c, nav }: { c: any; nav: (to: string) => void }) {
  return (
    <a className="case-row" href={`#/case/${c.id}`} onClick={(e) => { e.preventDefault(); nav(`/case/${c.id}`); }}>
      <div className="grow">
        <div className="title">{c.title}</div>
        <div className="sub">
          {c.company_name ?? "Unknown company"} · updated {fmtTime(c.updated_at)}
          {c.status_reason ? ` · ${c.status_reason}` : ""}
        </div>
      </div>
      <div className="amount">{money(c.amount_cents, c.currency)}</div>
      <span className={`chip chip-${statusTone(c.status)}`}>{c.paused ? "PAUSED" : c.status.replace(/_/g, " ")}</span>
    </a>
  );
}
