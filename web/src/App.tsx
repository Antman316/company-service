import { useCallback, useEffect, useState, type ReactElement } from "react";
import { api, setCsrf, type MeUser } from "./api";
import { Landing } from "./pages/Landing";
import { Auth } from "./pages/Auth";
import { Dashboard } from "./pages/Dashboard";
import { NewCase } from "./pages/NewCase";
import { CaseDetail } from "./pages/CaseDetail";
import { Approvals } from "./pages/Approvals";
import { Connections } from "./pages/Connections";
import { Economics } from "./pages/Economics";
import { Results } from "./pages/Results";
import { Terms, Privacy, HowItWorks, Disclaimer, VerifyResult, ReportAbuse } from "./pages/Legal";

// Hash router — simplest reliable SPA routing behind static assets.
export function useRoute(): [string, (to: string) => void] {
  const [hash, setHash] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const fn = () => setHash(location.hash.slice(1) || "/");
    addEventListener("hashchange", fn);
    return () => removeEventListener("hashchange", fn);
  }, []);
  const nav = useCallback((to: string) => { location.hash = to; }, []);
  return [hash, nav];
}

export function App() {
  const [route, nav] = useRoute();
  const [me, setMe] = useState<MeUser | null | undefined>(undefined);
  const [pending, setPending] = useState(0);

  const refreshMe = useCallback(async () => {
    try {
      const r = await api.me();
      setCsrf(r.csrf);
      setMe(r.user);
      if (r.user) {
        const c = await api.listCases().catch(() => null);
        setPending(c?.pendingApprovals ?? 0);
      }
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => { refreshMe(); }, [refreshMe, route]);

  const authed = !!me;
  const base = route.split("?")[0];

  // Route resolution — legal/trust pages are public, before the auth gate.
  let page: ReactElement;
  if (base === "/terms") page = <Terms />;
  else if (base === "/privacy") page = <Privacy />;
  else if (base === "/how") page = <HowItWorks />;
  else if (base === "/disclaimer") page = <Disclaimer />;
  else if (base === "/verified") page = <VerifyResult ok />;
  else if (base === "/verify-failed") page = <VerifyResult ok={false} />;
  else if (base === "/report") page = <ReportAbuse />;
  else if (!authed) {
    if (base === "/reset") page = <Auth onDone={refreshMe} initialMode="resetConfirm" />;
    else if (base === "/auth") page = <Auth onDone={refreshMe} />;
    else page = <Landing onCta={() => nav("/auth")} />;
  } else if (route.startsWith("/case/")) {
    page = <CaseDetail id={route.slice(6)} nav={nav} />;
  } else {
    switch (route) {
      case "/new": page = <NewCase nav={nav} />; break;
      case "/approvals": page = <Approvals nav={nav} onChanged={refreshMe} />; break;
      case "/connections": page = <Connections />; break;
      case "/economics": page = <Economics />; break;
      case "/results": page = <Results />; break;
      default: page = <Dashboard nav={nav} me={me!} />;
    }
  }

  return (
    <>
      <header className="topbar">
        <a className="brand" href={authed ? "#/app" : "#/"} style={{ color: "inherit" }}>
          <span className="brand-mark">CS</span>
          <span>Company Service</span>
        </a>
        {authed ? (
          <nav className="nav">
            <a href="#/app" className={route === "/app" || route === "/" ? "active" : ""}>Cases</a>
            <a href="#/approvals" className={route === "/approvals" ? "active" : ""}>
              Approvals{pending > 0 && <span className="badge">{pending}</span>}
            </a>
            <a href="#/connections" className={route === "/connections" ? "active" : ""}>Connections</a>
            <a href="#/economics" className={route === "/economics" ? "active" : ""}>Economics</a>
            <a href="#/results" className={route === "/results" ? "active" : ""}>Results</a>
            <button className="btn btn-ghost btn-sm" onClick={async () => { await api.signout(); setCsrf(null); setMe(null); nav("/"); }}>
              Sign out
            </button>
          </nav>
        ) : (
          <nav className="nav">
            <a href="#/auth" className="btn btn-primary btn-sm" style={{ color: "var(--accent-ink)" }}>Get it handled</a>
          </nav>
        )}
      </header>
      {me === undefined ? <div className="page"><span className="spinner" /></div> : (
        <>
          {authed && me && !me.emailVerified && base !== "/verified" && (
            <VerifyBanner />
          )}
          {page}
        </>
      )}
      <SiteFooter />
    </>
  );
}

function VerifyBanner() {
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="page" style={{ paddingBottom: 0 }}>
      <div className="verify-banner">
        <span><strong>Verify your email.</strong> Outbound sends to merchants and platform models stay off until you do.</span>
        {sent
          ? <span className="small">Sent — check your inbox.</span>
          : <button className="btn btn-sm btn-primary" onClick={async () => {
              try { await api.resendVerification(); setSent(true); }
              catch (e: any) { setErr(e.message); }
            }}>Resend verification email</button>}
        {err && <span className="small" style={{ color: "var(--red)" }}>{err}</span>}
      </div>
    </div>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <a href="#/how">How it works</a>
      <a href="#/terms">Terms</a>
      <a href="#/privacy">Privacy</a>
      <a href="#/disclaimer">Not legal advice</a>
      <a href="#/report">Report abuse</a>
    </footer>
  );
}
