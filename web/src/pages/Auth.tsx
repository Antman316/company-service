import { useEffect, useRef, useState } from "react";
import { api, setCsrf } from "../api";

declare const turnstile: any;

type Mode = "signin" | "signup" | "totp" | "reset" | "resetConfirm";

export function Auth({ onDone, initialMode }: { onDone: () => void; initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode ?? "signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [code, setCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [resetToken] = useState(() => new URLSearchParams(location.hash.split("?")[1] ?? "").get("token") ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const [tsToken, setTsToken] = useState<string | null>(null);
  const [siteKey, setSiteKey] = useState<string | null>(null);

  // Turnstile widget (signup only): renders when the server reports a site key.
  useEffect(() => {
    let cancelled = false;
    api.authConfig().then((c) => { if (!cancelled) setSiteKey(c.turnstileSiteKey); }).catch(() => null);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!siteKey || mode !== "signup" || !turnstileRef.current) return;
    const render = () => {
      try {
        turnstile.render(turnstileRef.current, {
          sitekey: siteKey,
          callback: (tok: string) => setTsToken(tok),
          "error-callback": () => setTsToken(null),
          "expired-callback": () => setTsToken(null),
        });
      } catch { /* already rendered */ }
    };
    if (typeof turnstile !== "undefined") { render(); return; }
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    s.onload = render;
    document.head.appendChild(s);
  }, [siteKey, mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === "signup") {
        const r = await api.signup(email, password, consent, tsToken ?? undefined);
        setCsrf(r.csrf);
        onDone();
        location.hash = "/app";
      } else if (mode === "signin") {
        const r = await api.signin(email, password);
        if (r.totpRequired && r.ticket) {
          setTicket(r.ticket); setMode("totp"); setCode("");
        } else {
          setCsrf(r.csrf ?? null);
          onDone();
          location.hash = "/app";
        }
      } else if (mode === "totp") {
        const r = await api.totpChallenge(ticket!, code);
        setCsrf(r.csrf);
        onDone();
        location.hash = "/app";
      } else if (mode === "reset") {
        await api.requestReset(email);
        setNotice("If that email has an account, a reset link is on its way.");
      } else if (mode === "resetConfirm") {
        await api.confirmReset(resetToken, password);
        setNotice("Password reset — sign in with your new password.");
        setMode("signin"); setPassword("");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const title: Record<Mode, string> = {
    signup: "Create your account",
    signin: "Welcome back",
    totp: "Two-factor check",
    reset: "Reset your password",
    resetConfirm: "Choose a new password",
  };

  return (
    <div className="auth-wrap">
      <div className="card">
        <h2 style={{ marginBottom: 4 }}>{title[mode]}</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          {mode === "signup" && "Your cases, evidence, and connections stay private to you."}
          {mode === "signin" && "Sign in to your cases."}
          {mode === "totp" && "Enter the 6-digit code from your authenticator app."}
          {mode === "reset" && "We'll email you a one-time reset link."}
          {mode === "resetConfirm" && "This link works once. Pick a password you'll remember."}
        </p>
        {error && <div className="error-box">{error}</div>}
        {notice && <div className="notice-box">{notice}</div>}
        <form onSubmit={submit}>
          {(mode === "signup" || mode === "signin" || mode === "reset") && (
            <div className="field">
              <label>Email</label>
              <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </div>
          )}
          {(mode === "signup" || mode === "signin" || mode === "resetConfirm") && (
            <div className="field">
              <label>{mode === "resetConfirm" ? "New password" : "Password"}</label>
              <input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
              {mode !== "signin" && <div className="hint">At least 8 characters.</div>}
            </div>
          )}
          {mode === "resetConfirm" && (
            <div className="field">
              <label>Repeat it</label>
              <input className="input" type="password" required minLength={8} value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
              {confirmPw && confirmPw !== password && <div className="hint" style={{ color: "var(--red)" }}>Passwords don't match.</div>}
            </div>
          )}
          {mode === "totp" && (
            <div className="field">
              <label>Authenticator code</label>
              <input className="input" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" placeholder="123456" />
            </div>
          )}
          {mode === "signup" && (
            <>
              <label className="check-row">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span className="small">
                  I agree to the <a href="#/terms" target="_blank">Terms of Service</a> and{" "}
                  <a href="#/privacy" target="_blank">Privacy Policy</a>, and I understand Company Service
                  is not a law firm and gives no legal advice.
                </span>
              </label>
              {siteKey && <div ref={turnstileRef} style={{ margin: "10px 0" }} />}
            </>
          )}
          <button
            className="btn btn-primary"
            style={{ width: "100%", justifyContent: "center" }}
            disabled={
              busy ||
              (mode === "signup" && (!consent || (siteKey !== null && !tsToken))) ||
              (mode === "resetConfirm" && confirmPw !== password)
            }
          >
            {busy ? <span className="spinner" /> :
              mode === "signup" ? "Create account" :
              mode === "signin" ? "Sign in" :
              mode === "totp" ? "Verify" :
              mode === "reset" ? "Email me a reset link" : "Reset password"}
          </button>
        </form>
      </div>
      <div className="auth-switch">
        {mode === "signup" && <>Already have an account? <a href="#/auth" onClick={(e) => { e.preventDefault(); setMode("signin"); }}>Sign in</a></>}
        {mode === "signin" && (
          <>
            New here? <a href="#/auth" onClick={(e) => { e.preventDefault(); setMode("signup"); }}>Create an account</a>
            {" · "}
            <a href="#/auth" onClick={(e) => { e.preventDefault(); setMode("reset"); }}>Forgot password?</a>
          </>
        )}
        {mode === "reset" && <>Remembered it? <a href="#/auth" onClick={(e) => { e.preventDefault(); setMode("signin"); }}>Sign in</a></>}
        {mode === "totp" && <a href="#/auth" onClick={(e) => { e.preventDefault(); setMode("signin"); setTicket(null); }}>Back</a>}
        {mode === "resetConfirm" && !resetToken && <div className="error-box">Missing reset token — use the link from your email.</div>}
      </div>
    </div>
  );
}
