import { useCallback, useEffect, useState } from "react";
import { api, EVENT_LABELS, fmtTime, money, statusTone } from "../api";

const PROV_TONE: Record<string, string> = {
  CUSTOMER_STATED: "amber", DOCUMENT_VERIFIED: "green", MERCHANT_STATED: "blue",
  SYSTEM_VERIFIED: "green", INFERRED: "", CONFLICTING: "red", UNKNOWN: "",
};

export function CaseDetail({ id, nav }: { id: string; nav: (to: string) => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"timeline" | "messages" | "evidence">("timeline");
  const [note, setNote] = useState("");
  const [evText, setEvText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.caseDetail(id).then(setD).catch((e) => setErr(e.message));
  }, [id]);
  useEffect(load, [load]);

  async function act(name: string, fn: () => Promise<any>) {
    setBusy(name);
    try { await fn(); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }

  async function decide(approvalId: string, optionId: string) {
    await act("decide", () => api.decide(approvalId, optionId));
  }

  async function onUpload(file: File) {
    await act("upload", () => api.uploadEvidence(id, file));
  }

  if (err) return <div className="page"><div className="error-box">{err}</div></div>;
  if (!d) return <div className="page"><span className="spinner" /></div>;

  const c = d.case;
  const pendingApprovals = (d.approvals ?? []).filter((a: any) => a.status === "pending");
  const open = !["RESOLVED", "UNRESOLVED", "CANCELLED", "UNSUPPORTED"].includes(c.status);
  const nextFollowUp = (d.followUps ?? []).find((f: any) => f.status === "pending");

  return (
    <div className="page">
      <a href="#/app" className="small muted">← All cases</a>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1 style={{ margin: 0, letterSpacing: "-.02em", fontSize: 26 }}>{c.title}</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            {c.company_name ?? "Company not identified"} · {money(c.amount_cents, c.currency)}
            {c.status_reason ? ` · ${c.status_reason}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`chip chip-${statusTone(c.status)}`}>{c.paused ? "PAUSED" : c.status.replace(/_/g, " ")}</span>
          {open && (c.paused
            ? <button className="btn btn-sm" onClick={() => act("resume", () => api.resumeCase(id))}>Resume</button>
            : <button className="btn btn-sm" onClick={() => act("pause", () => api.pauseCase(id))}>Pause</button>)}
          {open && <button className="btn btn-sm" disabled={busy === "run"} onClick={() => act("run", () => api.runCase(id))}>Run now</button>}
          {d.mandate?.status === "active" && open && (
            <button className="btn btn-sm btn-danger" onClick={() => act("revoke", () => api.revokeMandate(id))}>Revoke authority</button>
          )}
          {open && <button className="btn btn-sm btn-ghost" onClick={() => act("cancel", () => api.cancelCase(id))}>Cancel case</button>}
        </div>
      </div>

      {pendingApprovals.length > 0 && (
        <div style={{ marginTop: 18 }}>
          {pendingApprovals.map((a: any) => (
            <div className="approval-card" key={a.id}>
              <div className="kind">Needs your decision · {a.kind.replace(/_/g, " ")}</div>
              <div className="summary">{a.summary}</div>
              <div className="option-row">
                {(a.options ?? []).map((o: any) => (
                  <button key={o.id} className={`btn btn-sm ${o.id === "accept" || o.id === "approve" || o.id === "received" ? "btn-primary" : ""}`}
                    disabled={busy === "decide"} onClick={() => decide(a.id, o.id)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {nextFollowUp && open && (
        <div className="notice" style={{ marginTop: 16 }}>
          Next scheduled follow-up: <strong>{nextFollowUp.kind.replace(/_/g, " ")}</strong> — due {fmtTime(nextFollowUp.dueAt)}
        </div>
      )}

      <div className="grid grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>Objective</div>
          <dl className="kv">
            <dt>Issue</dt><dd>{c.issue_type?.replace(/_/g, " ") ?? "—"}</dd>
            <dt>Order</dt><dd>{d.orderRef ?? "—"}</dd>
            <dt>Amount</dt><dd>{money(c.amount_cents, c.currency)}</dd>
            <dt>Wants</dt><dd>{c.desired_outcome ?? "—"}</dd>
          </dl>
        </div>

        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>Outcome — stated honestly</div>
          {d.outcome ? (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className={`chip chip-${statusTone(d.outcome.status)}`}>{d.outcome.status.replace(/_/g, " ")}</span>
              </div>
              <p className="small" style={{ marginBottom: 0 }}>{d.outcome.detail}</p>
            </>
          ) : <p className="muted small">No outcome recorded yet.</p>}
        </div>

        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>Your authorization</div>
          {d.mandate ? (
            <>
              <p className="small muted" style={{ margin: "0 0 8px" }}>
                {d.mandate.status.toUpperCase()} · v{d.mandate.version} · expires {fmtTime(d.mandate.expires_at)}
              </p>
              <ul className="mandate-list">
                {(d.mandate.authorized ?? []).map((g: string) => <li key={g}>{g.replace(/_/g, " ")}</li>)}
              </ul>
              {(d.mandate.approvalRequired ?? []).length > 0 && (
                <>
                  <div className="section-title">Asks you first</div>
                  <ul className="mandate-list req">
                    {(d.mandate.approvalRequired ?? []).map((g: string) => <li key={g}>{g.replace(/_/g, " ")}</li>)}
                  </ul>
                </>
              )}
            </>
          ) : (
            <p className="muted small">No mandate granted yet — the agent will not act until you authorize it.</p>
          )}
        </div>

        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>Facts & provenance</div>
          {(d.claims ?? []).length === 0 && <p className="muted small">No claims recorded.</p>}
          {(d.claims ?? []).map((cl: any) => (
            <div className="claim" key={cl.id}>
              <span className={`chip chip-${PROV_TONE[cl.status] ?? ""} st`}>{cl.status.replace(/_/g, " ")}</span>
              <span>{cl.text}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="tabs" style={{ marginTop: 28 }}>
        {(["timeline", "messages", "evidence"] as const).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t === "timeline" ? `Timeline (${d.events?.length ?? 0})` : t === "messages" ? `Messages (${d.messages?.length ?? 0})` : `Evidence (${d.evidence?.length ?? 0})`}
          </button>
        ))}
      </div>

      {tab === "timeline" && (
        <div className="timeline">
          {(d.events ?? []).slice().reverse().map((e: any) => (
            <div className={`tl-item actor-${e.actor}`} key={e.id}>
              <div className="tl-head">
                <span className="tl-type">{EVENT_LABELS[e.type] ?? e.type.replace(/_/g, " ")}</span>
                <span className="tl-actor">{e.actor}</span>
                <span className="tl-time">{fmtTime(e.at)}</span>
              </div>
              {e.data?.detail && <div className="tl-body">{e.data.detail}</div>}
            </div>
          ))}
        </div>
      )}

      {tab === "messages" && (
        <div>
          {(d.messages ?? []).length === 0 && <div className="empty small">No messages yet — the agent will write to the company here.</div>}
          {(d.messages ?? []).map((m: any) => (
            <div className={`msg ${m.direction === "out" ? "msg-out" : "msg-in"}`} key={m.id}>
              <div className="dir">{m.direction === "out" ? `Your agent → company (${m.channel.replace(/_/g, " ")})` : `Company → your agent (${m.channel.replace(/_/g, " ")})`}</div>
              <div className="body">{m.body}</div>
              <div className="time">{fmtTime(m.at)}{m.status !== "sent" ? ` · ${m.status}` : ""}</div>
            </div>
          ))}
        </div>
      )}

      {tab === "evidence" && (
        <div>
          {(d.evidence ?? []).map((ev: any) => (
            <div className="evidence-item" key={ev.id}>
              <span className="kind">{ev.kind.replace(/_/g, " ")}</span>
              <span style={{ flex: 1 }}>{ev.label ?? ev.text?.slice(0, 80) ?? "—"}</span>
              <span className="chip">{ev.source}</span>
              {ev.hasFile && <a className="btn btn-sm btn-ghost" href={`/api/cases/${id}/evidence/${ev.id}/file`} target="_blank" rel="noreferrer">view</a>}
            </div>
          ))}
          <div className="card" style={{ marginTop: 14 }}>
            <div className="field">
              <label>Add a statement or document link</label>
              <textarea className="textarea" style={{ minHeight: 70 }} placeholder="e.g. UPS return receipt #1Z… dropped off Oct 1" value={evText} onChange={(e) => setEvText(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn btn-sm" disabled={!evText.trim() || busy === "ev"} onClick={() => act("ev", async () => { await api.addEvidence(id, { text: evText, kind: "statement" }); setEvText(""); })}>
                Add evidence
              </button>
              <label className="btn btn-sm" style={{ margin: 0 }}>
                Upload file
                <input type="file" hidden onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
              </label>
              {busy === "upload" && <span className="spinner" />}
            </div>
          </div>
        </div>
      )}

      {open && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="field" style={{ marginBottom: 8 }}>
            <label>Add a note for your agent</label>
            <textarea className="textarea" style={{ minHeight: 60 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. I found the order number — it's TM-1042" />
          </div>
          <button className="btn btn-sm" disabled={!note.trim() || busy === "note"} onClick={() => act("note", async () => { await api.addNote(id, note); setNote(""); })}>
            Add note
          </button>
        </div>
      )}
    </div>
  );
}
