import { useCallback, useEffect, useState, type ReactElement } from "react";
import { api, setCsrf } from "./api";
import { Landing } from "./pages/Landing";
import { Auth } from "./pages/Auth";
import { Dashboard } from "./pages/Dashboard";
import { NewCase } from "./pages/NewCase";
import { CaseDetail } from "./pages/CaseDetail";
import { Approvals } from "./pages/Approvals";
import { Connections } from "./pages/Connections";
import { Economics } from "./pages/Economics";

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
  const [me, setMe] = useState<{ id: string; email: string } | null | undefined>(undefined);
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

  // Route resolution.
  let page: ReactElement;
  if (!authed) {
    if (route === "/auth") page = <Auth onDone={refreshMe} />;
    else page = <Landing onCta={() => nav("/auth")} />;
  } else if (route.startsWith("/case/")) {
    page = <CaseDetail id={route.slice(6)} nav={nav} />;
  } else {
    switch (route) {
      case "/new": page = <NewCase nav={nav} />; break;
      case "/approvals": page = <Approvals nav={nav} onChanged={refreshMe} />; break;
      case "/connections": page = <Connections />; break;
      case "/economics": page = <Economics />; break;
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
      {me === undefined ? <div className="page"><span className="spinner" /></div> : page}
    </>
  );
}
