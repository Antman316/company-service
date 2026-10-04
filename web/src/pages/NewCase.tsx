import { useState } from "react";
import { api, money } from "../api";

const EXAMPLES = [
  "Amazon owes me $84.17 for something I returned three weeks ago. I still haven't gotten the refund.",
  "Test Merchant never refunded my $120 return of order TM-1042.",
  "Walmart sent me the wrong item and won't respond.",
  "My order arrived damaged and the company is ignoring me.",
];

const AUTHORIZABLE = [
  ["contact_company", "Contact the company on your behalf"],
  ["request_refund", "Request the refund you described"],
  ["share_order_number", "Share the order number"],
  ["share_tracking_number", "Share return tracking numbers"],
  ["share_evidence", "Share the evidence in this case"],
  ["follow_up", "Follow up when deadlines pass"],
  ["request_escalation", "Ask for a supervisor / escalate"],
];

const APPROVAL_GATED = [
  ["accept_partial_refund", "Accept less than the requested amount"],
  ["accept_store_credit", "Accept store credit instead of money"],
  ["accept_replacement", "Accept a replacement instead of refund"],
  ["agree_to_fee", "Pay or accept any fee"],
  ["change_delivery", "Change delivery arrangements"],
  ["accept_new_terms", "Accept new terms or conditions"],
  ["close_case_satisfied", "Close this case as satisfied"],
];

export function NewCase({ nav }: { nav: (to: string) => void }) {
  const [text, setText] = useState("");
  const [scenario, setScenario] = useState("standard_refund_flow");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [created, setCreated] = useState<{ caseId: string; objective: any; suggestedMandate: any } | null>(null);
  const [grants, setGrants] = useState<Record<string, boolean>>({});
  const [gate, setGate] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usesSim = /test merchant/i.test(text);

  async function create() {
    setBusy(true); setErr(null);
    try {
      const r = await api.createCase(text, usesSim ? scenario : undefined);
      setCreated(r);
      const g: Record<string, boolean> = {};
      for (const a of (r.suggestedMandate?.authorized ?? [])) g[a] = true;
      const gate0: Record<string, boolean> = {};
      for (const a of (r.suggestedMandate?.approvalRequired ?? [])) gate0[a] = true;
      setGrants(g);
      setGate(gate0);
      setStep(3);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function authorize() {
    if (!created) return;
    setBusy(true); setErr(null);
    try {
      const authorized = Object.entries(grants).filter(([, v]) => v).map(([k]) => k);
      const approvalRequired = Object.entries(gate).filter(([, v]) => v).map(([k]) => k);
      await api.grantMandate(created.caseId, { authorized, approvalRequired });
      nav(`/case/${created.caseId}`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const ob = created?.objective;

  return (
    <div className="page page-narrow">
      {step === 1 && (
        <>
          <h1 style={{ letterSpacing: "-.02em" }}>What do you need handled?</h1>
          <p className="muted">Describe the problem the same way you'd tell a person.</p>
          <textarea
            className="big-input"
            placeholder="e.g. Amazon owes me $84.17 for something I returned three weeks ago…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <div className="examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" onClick={() => setText(ex)}>{ex.slice(0, 58)}…</button>
            ))}
          </div>
          {usesSim && (
            <div className="notice notice-warn" style={{ marginTop: 16 }}>
              <strong>Demo merchant detected.</strong> "Test Merchant" is a deterministic simulation used to prove the product — it is always labeled SIMULATED.
              <div className="field" style={{ margin: "10px 0 0" }}>
                <label>Merchant script</label>
                <select className="select" value={scenario} onChange={(e) => setScenario(e.target.value)}>
                  <option value="standard_refund_flow">Promises refund, resolves on follow-up</option>
                  <option value="partial_offer">Offers partial store credit</option>
                  <option value="denial">Denies the claim</option>
                  <option value="evidence_request">Requests evidence</option>
                  <option value="delayed">Says "respond tomorrow"</option>
                  <option value="escalation">Requires escalation</option>
                  <option value="injection">Attempts prompt injection</option>
                </select>
              </div>
            </div>
          )}
          <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 10 }}>
            {err && <span className="error-box" style={{ margin: 0, flex: 1 }}>{err}</span>}
            <button className="btn btn-primary" disabled={text.trim().length < 10 || busy} onClick={create}>
              {busy ? <span className="spinner" /> : "Continue"}
            </button>
          </div>
        </>
      )}

      {step === 3 && created && (
        <>
          <h1 style={{ letterSpacing: "-.02em" }}>Here's what your agent understood</h1>
          <div className="card">
            <dl className="kv">
              <dt>Company</dt><dd>{ob?.company ?? <em className="muted">not identified yet</em>}</dd>
              <dt>Issue</dt><dd>{ob?.issueType?.replace(/_/g, " ") ?? "—"}</dd>
              <dt>Order</dt><dd>{ob?.orderRef ?? <em className="muted">not provided — the agent will ask</em>}</dd>
              <dt>Amount</dt><dd>{money(ob?.amountCents, ob?.currency)}</dd>
              <dt>Wants</dt><dd>{ob?.desiredOutcome ?? "—"}</dd>
            </dl>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Facts are stored with provenance — customer statements stay labeled until evidence verifies them.
            </p>
          </div>

          <h2 style={{ marginTop: 28, fontSize: 18 }}>Give your agent permission</h2>
          <p className="muted small">Your agent can never do more than you check here — not even if the company or the model asks. Anything else comes back to you.</p>
          <div className="card">
            <div className="section-title" style={{ marginTop: 0 }}>Authorized without asking</div>
            <ul className="check-list">
              {AUTHORIZABLE.map(([k, label]) => (
                <li key={k}>
                  <input type="checkbox" id={`g-${k}`} checked={!!grants[k]} onChange={(e) => setGrants({ ...grants, [k]: e.target.checked })} />
                  <label htmlFor={`g-${k}`}>{label}</label>
                </li>
              ))}
            </ul>
            <div className="section-title">Always ask me first</div>
            <ul className="check-list">
              {APPROVAL_GATED.map(([k, label]) => (
                <li key={k}>
                  <input type="checkbox" id={`r-${k}`} checked={!!gate[k]} onChange={(e) => setGate({ ...gate, [k]: e.target.checked })} />
                  <label htmlFor={`r-${k}`}>{label}</label>
                </li>
              ))}
            </ul>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Purchases, bank transfers, accepting legal settlements, fabricated statements, and anything outside this mandate are always prohibited.
            </p>
          </div>
          <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button className="btn btn-ghost" onClick={() => nav(`/case/${created.caseId}`)}>Decide later</button>
            <button className="btn btn-primary" disabled={busy} onClick={authorize}>
              {busy ? <span className="spinner" /> : "Authorize and start"}
            </button>
          </div>
          {err && <div className="error-box" style={{ marginTop: 12 }}>{err}</div>}
        </>
      )}
    </div>
  );
}
