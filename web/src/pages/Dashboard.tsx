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
          <div className="big">What do you need handled?</div>
          <p>Describe a problem with a company — a missing refund, a wrong item, a damaged delivery — and your agent takes it from there.</p>
          <button className="btn btn-primary" onClick={() => nav("/new")}>Start your first case</button>
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
    </div>
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
