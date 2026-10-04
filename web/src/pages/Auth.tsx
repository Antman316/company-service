import { useState } from "react";
import { api, setCsrf } from "../api";

export function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = mode === "signup" ? await api.signup(email, password) : await api.signin(email, password);
      setCsrf(r.csrf);
      onDone();
      location.hash = "/app";
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="card">
        <h2 style={{ marginBottom: 4 }}>{mode === "signup" ? "Create your account" : "Welcome back"}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {mode === "signup" ? "Your cases, evidence, and connections stay private to you." : "Sign in to your cases."}
        </p>
        {error && <div className="error-box">{error}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label>Email</label>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div className="field">
            <label>Password</label>
            <input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
            {mode === "signup" && <div className="hint">At least 8 characters.</div>}
          </div>
          <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
            {busy ? <span className="spinner" /> : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>
      </div>
      <div className="auth-switch">
        {mode === "signup" ? (
          <>Already have an account? <a href="#/auth" onClick={(e) => { e.preventDefault(); setMode("signin"); }}>Sign in</a></>
        ) : (
          <>New here? <a href="#/auth" onClick={(e) => { e.preventDefault(); setMode("signup"); }}>Create an account</a></>
        )}
      </div>
    </div>
  );
}
