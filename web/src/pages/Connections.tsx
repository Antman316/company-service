import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

const PROVIDERS = [
  { id: "local_dev", label: "Built-in (deterministic dev provider)", fields: [] as const, note: "No credentials needed. Powers extraction/planning/compose locally — not a real model." },
  { id: "openai", label: "OpenAI (API key)", fields: [{ k: "api_key", label: "API key", secret: true }, { k: "model", label: "Model (e.g. gpt-4o-mini)", secret: false }] },
  { id: "anthropic", label: "Anthropic (API key)", fields: [{ k: "api_key", label: "API key", secret: true }, { k: "model", label: "Model (e.g. claude-haiku-4-5)", secret: false }] },
  { id: "openai_compatible", label: "OpenAI-compatible endpoint", fields: [{ k: "base_url", label: "Base URL", secret: false }, { k: "api_key", label: "API key", secret: true }, { k: "model", label: "Model", secret: false }] },
  { id: "local_endpoint", label: "Local model endpoint (Ollama etc.)", fields: [{ k: "base_url", label: "Base URL (e.g. http://localhost:11434/v1)", secret: false }, { k: "model", label: "Model", secret: false }] },
];

const AUTOMATION_TONE: Record<string, string> = { SIMULATED: "amber", AUTOMATED: "green", ASSISTED: "blue", CONTACT_CONFIRMED: "blue", MANUAL_HANDOFF: "blue", UNSUPPORTED: "red", TEMPORARILY_UNAVAILABLE: "amber" };

export function Connections() {
  const [conns, setConns] = useState<any[] | null>(null);
  const [pairings, setPairings] = useState<any[] | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [cov, setCov] = useState<any>(null);
  const [provider, setProvider] = useState(PROVIDERS[0].id);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    api.connections().then((r) => setConns(r.connections)).catch(() => setConns([]));
    api.companionPairings().then((r) => setPairings(r.pairings)).catch(() => setPairings([]));
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
        <div className="section-title" style={{ marginTop: 0 }}>Chat companion</div>
        <p className="small muted">
          The Chrome extension assists you inside merchant support chats — it reads the chat you point it at,
          shows the drafted reply, and never presses send. Pair by generating a short code here and entering it
          in the extension's side panel.
        </p>
        <button className="btn btn-primary" onClick={async () => {
          setErr(null); setMsg(null);
          try {
            const r = await api.companionCode();
            setPairCode(r.code);
            load();
          } catch (e: any) { setErr(e.message); }
        }}>Generate pairing code</button>
        {pairCode && (
          <div className="notice" style={{ marginTop: 10 }}>
            Enter this code in the extension (15 minutes): <strong style={{ letterSpacing: "0.15em" }}>{pairCode}</strong>
          </div>
        )}
        {(pairings ?? []).filter((x) => !x.revoked_at && x.label !== "pending").length > 0 && (
          <div style={{ marginTop: 12 }}>
            {(pairings ?? []).filter((x) => !x.revoked_at && x.label !== "pending").map((x) => (
              <div className="evidence-item" key={x.id}>
                <span style={{ flex: 1 }}>
                  <strong>{x.label ?? "companion"}</strong>
                  <span className="small muted" style={{ display: "block" }}>paired {String(x.created_at).slice(0, 10)}</span>
                </span>
                <button className="btn btn-sm btn-ghost" onClick={async () => { await api.companionRevoke(x.id); load(); }}>Revoke</button>
              </div>
            ))}
          </div>
        )}
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
                const degraded = cv.health === "degraded";
                return (
                  <span key={cv.id}
                    className={`chip chip-${degraded ? "amber" : honest ? AUTOMATION_TONE[cv.verification_status] ?? "amber" : "green"}`}
                    title={`${cv.channel} · ${cv.automation_level} · ${cv.verification_status}${degraded ? " — lane degraded" : ""}${cv.limitations ? " — " + cv.limitations : ""}`}>
                    {cv.channel}: {label.replace(/_/g, " ")}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <SecuritySection />
    </div>
  );
}

// M7 — account security: TOTP 2FA enrollment + notification preferences.
function SecuritySection() {
  const [me, setMe] = useState<any>(null);
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [enroll, setEnroll] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");
  const [secErr, setSecErr] = useState<string | null>(null);
  const [secMsg, setSecMsg] = useState<string | null>(null);

  const PREF_LABELS: Record<string, string> = {
    merchant_replied: "Merchant replies",
    approval_needed: "Approvals waiting on me",
    deadline_approaching: "Deadline in 2 days",
    money_checkin: "Money promised — check-ins",
    case_resolved: "Case resolved",
  };

  const load = useCallback(() => {
    api.me().then((r) => setMe(r.user)).catch(() => setMe(null));
    api.notificationPrefs().then((r) => setPrefs(r.prefs)).catch(() => setPrefs(null));
  }, []);
  useEffect(load, [load]);

  async function confirmEnroll() {
    setSecErr(null); setSecMsg(null);
    try {
      await api.totpConfirm(code);
      setEnroll(null); setCode("");
      setSecMsg("Two-factor is on.");
      load();
    } catch (e: any) { setSecErr(e.message); }
  }
  async function disable() {
    setSecErr(null); setSecMsg(null);
    try {
      await api.totpDisable(code);
      setCode(""); setSecMsg("Two-factor is off.");
      load();
    } catch (e: any) { setSecErr(e.message); }
  }

  return (
    <div className="grid grid-2" style={{ marginTop: 16 }}>
      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>Security</div>
        <div className="pref-row">
          <span>Email verification</span>
          <span className={`chip chip-${me?.emailVerified ? "green" : "amber"}`}>{me?.emailVerified ? "verified" : "pending"}</span>
        </div>
        <div className="pref-row">
          <span>Two-factor (authenticator app)</span>
          <span className={`chip chip-${me?.totpEnabled ? "green" : ""}`}>{me?.totpEnabled ? "on" : "off"}</span>
        </div>
        {!me?.totpEnabled && !enroll && (
          <button className="btn" style={{ marginTop: 12 }} onClick={async () => {
            setSecErr(null);
            try { setEnroll(await api.totpEnroll()); } catch (e: any) { setSecErr(e.message); }
          }}>Set up two-factor</button>
        )}
        {enroll && (
          <div className="totp-box" style={{ marginTop: 12 }}>
            <p className="small muted" style={{ margin: 0 }}>
              Add this secret to your authenticator (or scan the otpauth URI in a QR tool):
            </p>
            <span className="totp-secret">{enroll.secret}</span>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Enter the 6-digit code to confirm</label>
              <input className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={confirmEnroll}>Enable</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setEnroll(null); setCode(""); }}>Cancel</button>
            </div>
          </div>
        )}
        {me?.totpEnabled && (
          <div className="totp-box" style={{ marginTop: 12 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Enter a code to disable 2FA</label>
              <input className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            </div>
            <div><button className="btn btn-ghost btn-sm" onClick={disable}>Disable two-factor</button></div>
          </div>
        )}
        {secErr && <div className="error-box" style={{ marginTop: 10 }}>{secErr}</div>}
        {secMsg && <div className="notice" style={{ marginTop: 10 }}>{secMsg}</div>}
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>Email notifications</div>
        <p className="small muted" style={{ marginTop: 0 }}>
          Sent from the system mailbox to your account email — never through a case connection.
        </p>
        {prefs === null ? <span className="muted small">Loading…</span> : Object.keys(PREF_LABELS).map((k) => (
          <div className="pref-row" key={k}>
            <span>{PREF_LABELS[k]}</span>
            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={prefs[k] !== false}
                onChange={async (e) => {
                  const on = e.target.checked;
                  setPrefs({ ...prefs, [k]: on });
                  try { await api.setNotificationPref(k, on); } catch { setPrefs({ ...prefs, [k]: !on }); }
                }}
              />
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
