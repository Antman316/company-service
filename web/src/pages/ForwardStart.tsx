import { useState } from "react";
import { api } from "../api";

export function ForwardStartConfirm({ nav }: { nav: (to: string) => void }) {
  const query = location.hash.split("?")[1] ?? "";
  const token = new URLSearchParams(query).get("token") ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="page narrow">
      <section className="card stack">
        <h1>Confirm this forwarded email</h1>
        <p>
          No case was created from the email alone. Confirm only if you sent it;
          this prevents a forged From address from adding content to your account.
        </p>
        {!token ? (
          <p className="error">This confirmation link is incomplete.</p>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await api.confirmForwardStart(token);
              nav(`/case/${r.caseId}`);
            } catch (e: any) {
              setError(e.message ?? "Confirmation failed");
            } finally {
              setBusy(false);
            }
          }}>
            {busy ? "Confirming…" : "Yes, start this case"}
          </button>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn btn-ghost" onClick={() => nav("/app")}>Ignore and return to cases</button>
      </section>
    </main>
  );
}
