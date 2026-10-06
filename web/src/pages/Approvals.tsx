import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

export function Approvals({ nav, onChanged }: { nav: (to: string) => void; onChanged: () => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api.approvals().then((r) => setItems(r.approvals)).catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  async function decide(id: string, optionId: string) {
    setBusy(id);
    try {
      // confirm_receipt "partial" carries the received amount.
      const raw = amounts[id];
      const cents = optionId === "partial" && raw
        ? Math.round(parseFloat(raw.replace(/[$,]/g, "")) * 100)
        : undefined;
      await api.decide(id, optionId, Number.isFinite(cents) ? cents : undefined);
      load(); onChanged();
    } finally { setBusy(null); }
  }

  return (
    <div className="page page-narrow">
      <h1 style={{ letterSpacing: "-.02em" }}>Approvals</h1>
      <p className="muted">Decisions your agent can't make alone. Nothing here happens until you choose.</p>
      {items === null ? (
        <div className="empty"><span className="spinner" /></div>
      ) : items.length === 0 ? (
        <div className="empty">
          <div className="big">Nothing waiting on you</div>
          <p>When a company offers something outside your mandate, it shows up here.</p>
        </div>
      ) : (
        items.map((a: any) => (
          <div className="approval-card" key={a.id}>
            <div className="kind">{a.kind.replace(/_/g, " ")}</div>
            <div className="summary">{a.summary}</div>
            {a.detail?.payload?.draft && (
              <details style={{ margin: "8px 0" }}>
                <summary className="small" style={{ cursor: "pointer" }}>View the draft — you review and file it yourself</summary>
                <pre className="small" style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto", marginTop: 6 }}>{a.detail.payload.draft}</pre>
              </details>
            )}
            {a.detail?.payload?.drafts && (
              <details style={{ margin: "8px 0" }}>
                <summary className="small" style={{ cursor: "pointer" }}>View the drafts — you review and file them yourself</summary>
                {(a.detail.payload.drafts as any[]).map((d2: any) => (
                  <div key={d2.agency} style={{ marginTop: 8 }}>
                    <div className="small"><strong>{d2.agency}</strong> — {d2.url}</div>
                    <pre className="small" style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflow: "auto" }}>{d2.body}</pre>
                  </div>
                ))}
              </details>
            )}
            {a.caseId && (
              <div className="small muted" style={{ marginBottom: 10 }}>
                <a href={`#/case/${a.caseId}`}>View case →</a>
              </div>
            )}
            {a.kind === "confirm_receipt" && (
              <div className="field" style={{ maxWidth: 220, marginBottom: 10 }}>
                <label className="small" htmlFor={`amt-${a.id}`}>Amount received (if partial)</label>
                <input
                  id={`amt-${a.id}`}
                  className="input"
                  inputMode="decimal"
                  placeholder="$0.00"
                  value={amounts[a.id] ?? ""}
                  onChange={(e) => setAmounts((m) => ({ ...m, [a.id]: e.target.value }))}
                />
              </div>
            )}
            <div className="option-row">
              {(a.options ?? []).map((o: any) => (
                <button key={o.id} className={`btn ${o.id === "accept" || o.id === "approve" || o.id === "received" ? "btn-primary" : ""}`}
                  disabled={busy === a.id} onClick={() => decide(a.id, o.id)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
