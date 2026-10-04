import { useEffect, useState } from "react";

interface Econ {
  casesByStatus: { status: string; n: number }[];
  costsByCase: { case_id: string; kind: string; cost: number; units: number }[];
  totalMicroUsd: number;
  casesWithCost: number;
  approvalsTotal: number;
  followUpsTotal: number;
  followUpsFired: number;
  byProvider: { provider: string; n: number; cost: number }[];
}

export function Economics() {
  const [d, setD] = useState<Econ | null>(null);

  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/economics", { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setD)
      .catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="page"><div className="error-box">Economics unavailable: {err}</div></div>;
  if (!d) return <div className="page"><span className="spinner" /></div>;

  const count = (s: string) => d.casesByStatus.find((x) => x.status === s)?.n ?? 0;
  const total = d.casesByStatus.reduce((a, x) => a + x.n, 0);
  const resolved = count("RESOLVED");
  const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;

  return (
    <div className="page">
      <h1 style={{ letterSpacing: "-.02em" }}>Case economics</h1>
      <p className="muted">
        Internal view — direct cost per case across model calls, sends, and tool executions.
        This environment is dev/test only; nothing here claims production economics.
      </p>

      <div className="grid grid-3" style={{ marginTop: 18 }}>
        <div className="card stat"><div className="n">{total}</div><div className="l">Cases</div></div>
        <div className="card stat"><div className="n">{resolved}</div><div className="l">Resolved</div></div>
        <div className="card stat"><div className="n">{count("UNSUPPORTED")}</div><div className="l">Unsupported</div></div>
      </div>
      <div className="grid grid-3" style={{ marginTop: 16 }}>
        <div className="card stat"><div className="n">{total ? (d.approvalsTotal / total).toFixed(1) : "—"}</div><div className="l">Approvals / case</div></div>
        <div className="card stat"><div className="n">{total ? (d.followUpsTotal / total).toFixed(1) : "—"}</div><div className="l">Follow-ups / case</div></div>
        <div className="card stat"><div className="n">{usd(d.totalMicroUsd)}</div><div className="l">Total direct cost</div></div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-title" style={{ marginTop: 0 }}>Cost by provider</div>
        {d.byProvider.length === 0 && <p className="muted small">No cost events recorded yet.</p>}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <tbody>
            {d.byProvider.map((p) => (
              <tr key={p.provider} style={{ borderTop: "1px solid var(--line)" }}>
                <td style={{ padding: "8px" }}>{p.provider}</td>
                <td style={{ padding: "8px" }} className="mono">{p.n} calls</td>
                <td style={{ padding: "8px", textAlign: "right" }} className="mono">{usd(p.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-title" style={{ marginTop: 0 }}>Cost per case</div>
        {d.costsByCase.length === 0 && <p className="muted small">No per-case costs yet.</p>}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--ink-3)", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em" }}>
              <th style={{ padding: "6px 8px" }}>Case</th>
              <th style={{ padding: "6px 8px" }}>Kind</th>
              <th style={{ padding: "6px 8px" }}>Units</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {d.costsByCase.map((e, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--line)" }}>
                <td style={{ padding: "6px 8px" }} className="mono">{e.case_id.slice(-6)}</td>
                <td style={{ padding: "6px 8px" }}>{e.kind}</td>
                <td style={{ padding: "6px 8px" }} className="mono">{e.units}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }} className="mono">{usd(e.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
