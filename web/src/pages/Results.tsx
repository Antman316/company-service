import { useEffect, useState } from "react";

interface Bucket {
  cases: number;
  received: number;
  documentVerified: number;
  verifiedResolved: number;
  claimedCents: number;
  recoveredCents: number;
  medianDaysToResolution: number | null;
  escalatedBeyondRung1: number;
  recoveredAfterEscalation: number;
}
interface ResultsData {
  generatedAt: string;
  caveat: string;
  total: Bucket;
  byMerchant: Record<string, Bucket>;
  byChannel: Record<string, Bucket>;
}

const usd = (c: number) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Table({ title, rows }: { title: string; rows: [string, Bucket][] }) {
  if (!rows.length) return null;
  return (
    <>
      <h2 style={{ marginTop: 28 }}>{title}</h2>
      <div className="card" style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>{title === "By channel" ? "Channel" : "Merchant"}</th>
              <th>Cases</th>
              <th>Received</th>
              <th>Doc-verified</th>
              <th>Verified resolved</th>
              <th>Recovered</th>
              <th>Median days</th>
              <th>Escalated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, b]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{b.cases}</td>
                <td>{b.received}</td>
                <td>{b.documentVerified}</td>
                <td>{b.verifiedResolved}</td>
                <td>{usd(b.recoveredCents)}</td>
                <td>{b.medianDaysToResolution ?? "—"}</td>
                <td>{b.escalatedBeyondRung1 ? `${b.recoveredAfterEscalation}/${b.escalatedBeyondRung1} recovered` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Results() {
  const [d, setD] = useState<ResultsData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/results", { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setD)
      .catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="page"><div className="error-box">Results unavailable: {err}</div></div>;
  if (!d) return <div className="page"><span className="spinner" /></div>;

  const t = d.total;
  const rate = t.cases ? Math.round((t.received / t.cases) * 100) : 0;

  return (
    <div className="page">
      <h1 style={{ letterSpacing: "-.02em" }}>Results</h1>
      <p className="muted">
        Every outcome is labeled by how it was verified — a merchant saying
        "refund issued" is a claim, not a receipt. <strong>Verified resolved</strong>{" "}
        requires a document (refund confirmation or bank statement) on file plus
        your confirmation. Customer-confirmed cases are counted honestly below it.
      </p>

      <div className="grid grid-3" style={{ marginTop: 18 }}>
        <div className="card stat"><div className="n">{t.cases}</div><div className="l">Cases</div></div>
        <div className="card stat"><div className="n">{usd(t.recoveredCents)}</div><div className="l">Recovered</div></div>
        <div className="card stat"><div className="n">{t.verifiedResolved}</div><div className="l">Verified resolved</div></div>
      </div>
      <div className="grid grid-3" style={{ marginTop: 16 }}>
        <div className="card stat"><div className="n">{rate}%</div><div className="l">Reached receipt</div></div>
        <div className="card stat"><div className="n">{t.medianDaysToResolution ?? "—"}</div><div className="l">Median days to resolution</div></div>
        <div className="card stat"><div className="n">{t.recoveredAfterEscalation}</div><div className="l">Receipts after escalation (rung ≥2)</div></div>
      </div>

      <Table title="By merchant" rows={Object.entries(d.byMerchant)} />
      <Table title="By channel" rows={Object.entries(d.byChannel)} />

      <p className="muted small" style={{ marginTop: 20 }}>
        {d.caveat} Generated {new Date(d.generatedAt).toLocaleString()}. Merchants with
        fewer than 3 cases are grouped as "other" so no individual case is identifiable.
      </p>
    </div>
  );
}
