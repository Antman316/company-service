import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

const PROVIDERS = [
  { id: "local_dev", label: "Built-in (deterministic dev provider)", fields: [] as const, note: "No credentials needed. Powers extraction/planning/compose locally — not a real model." },
  { id: "openai", label: "OpenAI (API key)", fields: [{ k: "api_key", label: "API key", secret: true }, { k: "model", label: "Model (e.g. gpt-4o-mini)", secret: false }] },
  { id: "anthropic", label: "Anthropic (API key)", fields: [{ k: "api_key", label: "API key", secret: true }, { k: "model", label: "Model (e.g. claude-haiku-4-5)", secret: false }] },
  { id: "openai_compatible", label: "OpenAI-compatible endpoint", fields: [{ k: "base_url", label: "Base URL", secret: false }, { k: "api_key", label: "API key", secret: true }, { k: "model", label: "Model", secret: false }] },
  { id: "local_endpoint", label: "Local model endpoint (Ollama etc.)", fields: [{ k: "base_url", label: "Base URL (e.g. http://localhost:11434/v1)", secret: false }, { k: "model", label: "Model", secret: false }] },
];

const AUTOMATION_TONE: Record<string, string> = { SIMULATED: "amber", AUTOMATED: "green", ASSISTED: "blue", MANUAL_HANDOFF: "blue", UNSUPPORTED: "red", TEMPORARILY_UNAVAILABLE: "amber" };

export function Connections() {
  const [conns, setConns] = useState<any[] | null>(null);
  const [cov, setCov] = useState<any>(null);
  const [provider, setProvider] = useState(PROVIDERS[0].id);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    api.connections().then((r) => setConns(r.connections)).catch(() => setConns([]));
    api.coverage().then(setCov).catch(() => null);
  }, []);
  useEffect(load, [load]);

  const p = PROVIDERS.find((x) => x.id === provider)!;

  async function add() {
    setErr(null); setMsg(null);
    try {
      await api.addConnection({ type: "model_provider", provider, label: p.label, config: vals });
      setVals({}); setMsg("Connection saved."); load();
    } catch (e: any) { setErr(e.message); }
  }

  async function test(id: string) {
    setErr(null); setMsg(null);
    try {
      const r = await api.testConnection(id);
      setMsg(r.ok ? "Health check passed." : `Health check failed: ${r.detail ?? "unknown"}`);
      load();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="page">
      <h1 style={{ letterSpacing: "-.02em" }}>Connections</h1>
      <p className="muted">Model providers and channels. Credentials are stored encrypted and never enter model context.</p>

      <div className="grid grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>Your connections</div>
          {(conns ?? []).length === 0 && <p className="muted small">None yet. The built-in deterministic provider handles dev cases without credentials.</p>}
          {(conns ?? []).map((c) => (
            <div className="evidence-item" key={c.id}>
              <span style={{ flex: 1 }}>
                <strong>{c.label}</strong>
                <span className="small muted" style={{ display: "block" }}>{c.type.replace(/_/g, " ")} · {c.provider}</span>
              </span>
              <span className={`chip chip-${c.status === "active" ? "green" : c.status === "error" ? "red" : ""}`}>{c.status}</span>
              <button className="btn btn-sm" onClick={() => test(c.id)}>Test</button>
              <button className="btn btn-sm btn-ghost" onClick={async () => { await api.removeConnection(c.id); load(); }}>Revoke</button>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>Add a model provider</div>
          <div className="field">
            <label>Provider</label>
            <select className="select" value={provider} onChange={(e) => { setProvider(e.target.value); setVals({}); }}>
              {PROVIDERS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            {p.note && <div className="hint">{p.note}</div>}
          </div>
          {p.fields.map((f) => (
            <div className="field" key={f.k}>
              <label>{f.label}</label>
              <input className="input" type={f.secret ? "password" : "text"} value={vals[f.k] ?? ""} onChange={(e) => setVals({ ...vals, [f.k]: e.target.value })} />
            </div>
          ))}
          {err && <div className="error-box">{err}</div>}
          {msg && <div className="notice" style={{ marginBottom: 10 }}>{msg}</div>}
          <button className="btn btn-primary" onClick={add}>Save connection</button>
          <p className="small muted" style={{ marginTop: 10 }}>
            Inbound case mail is live at <strong>cases@agentmasterkey.com</strong> via Cloudflare Email Routing —
            replies thread to your case automatically. Gmail send-only OAuth lands in V1.1.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-title" style={{ marginTop: 0 }}>Company coverage — stated honestly</div>
        <p className="small muted">Automation levels per company and channel. Nothing is claimed as working that hasn't been verified.</p>
        {(cov?.companies ?? []).map((co: any) => (
          <div key={co.id} style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
            <strong>{co.name}</strong>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              {(cov.coverage ?? []).filter((cv: any) => cv.company_id === co.id).map((cv: any) => {
                // Honesty rule: verification status takes precedence over the
                // nominal automation level — simulated/unsupported channels are
                // never shown as "automated".
                const honest = cv.verification_status !== "VERIFIED";
                const label = honest ? cv.verification_status : cv.automation_level;
                return (
                  <span key={cv.id}
                    className={`chip chip-${honest ? AUTOMATION_TONE[cv.verification_status] ?? "amber" : "green"}`}
                    title={`${cv.automation_level} · ${cv.verification_status}${cv.limitations ? " — " + cv.limitations : ""}`}>
                    {cv.channel}: {label.replace(/_/g, " ")}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
