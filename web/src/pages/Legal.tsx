// Public legal + trust pages — reachable without a session (hash routes:
// #/terms, #/privacy, #/how, #/disclaimer, #/verified, #/verify-failed, #/report).
import { useState } from "react";
import { api } from "../api";

export function Terms() {
  return (
    <div className="legal-page">
      <h1>Terms of Service</h1>
      <div className="muted-line">Company Service · Last updated October 2026</div>

      <h2>What Company Service is</h2>
      <p>Company Service is software that helps you resolve post-purchase problems — refunds, returns, missing or damaged items — by drafting communications, tracking deadlines, and (where you connect a supported channel) sending messages on your behalf.</p>
      <p>It is an <strong>agent you direct</strong>: it acts only inside the mandate you set, and every consequential action is either covered by that mandate or comes back to you for explicit approval.</p>

      <h2>What Company Service is not</h2>
      <ul>
        <li>Not a law firm, and nothing here is legal advice.</li>
        <li>Not a collection agency, claims service, or consumer-protection office.</li>
        <li>Not a guarantee of any outcome — merchants and card issuers decide outcomes.</li>
      </ul>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Provide accurate information. Drafts and filings are built from what you give us; false statements are your responsibility and violate these terms.</li>
        <li>Use it for your own purchases. You may not act for someone else without their authorization.</li>
        <li>Keep your account secured (strong password; turn on two-factor).</li>
      </ul>

      <h2>Prohibited use</h2>
      <ul>
        <li>Fraudulent, false, or exaggerated claims.</li>
        <li>Threats, harassment, or abusive language toward anyone.</li>
        <li>Attempts to bypass merchant security, CAPTCHAs, or access controls.</li>
        <li>Reselling access or operating the service for unrelated third parties.</li>
      </ul>
      <p>Violation of these ends your account and, where required, is reported.</p>

      <h2>Money</h2>
      <p>Results are recorded only when they actually happen: a refund counts when the merchant confirms it in writing or a document verifies it — never sooner. Fees, if any, are shown before you accept them.</p>

      <h2>Termination</h2>
      <p>You can delete your account anytime from Settings — it removes your cases, evidence, and stored credentials. We may suspend accounts for abuse, fraud, or these terms.</p>

      <h2>Liability</h2>
      <p>Provided "as is" to the extent the law allows. We are not liable for merchant decisions, missed merchant deadlines caused by your own delay in approvals, or amounts you could have recovered another way.</p>
    </div>
  );
}

export function Privacy() {
  return (
    <div className="legal-page">
      <h1>Privacy Policy</h1>
      <div className="muted-line">Company Service · Last updated October 2026</div>

      <h2>What we store</h2>
      <ul>
        <li>Your account email and password hash (PBKDF2, never plaintext).</li>
        <li>Your cases: what happened, evidence you add, messages exchanged, outcomes.</li>
        <li>Connection credentials you add (e.g. a model API key) — stored encrypted, decryptable only by the service.</li>
        <li>Operational logs and audit events for security and abuse prevention.</li>
      </ul>

      <h2>What we never do</h2>
      <ul>
        <li>We never store merchant account passwords or cookies.</li>
        <li>We never send email through your personal mail account — system mail (verification, reset, notifications) comes from our domain only.</li>
        <li>We never sell your data or use your cases to train third-party models.</li>
        <li>Merchant-sent text never feeds legal or dispute templates.</li>
      </ul>

      <h2>Your controls</h2>
      <ul>
        <li>Export everything we hold about you: Settings → Export my data.</li>
        <li>Delete everything: Settings → Delete account (irreversible).</li>
        <li>Notification preferences: per-kind opt-out in Settings.</li>
      </ul>

      <h2>Processors</h2>
      <p>Cloudflare (hosting, D1 database, R2 storage, Turnstile abuse checks) and Resend (system email delivery) process data as our subprocessors. AI model providers see case content only when you connect your own key or when platform models are enabled for verified accounts.</p>
    </div>
  );
}

export function HowItWorks() {
  return (
    <div className="legal-page">
      <h1>How it works — and what we never do</h1>
      <div className="muted-line">The honest version. If a claim ever disagrees with this page, this page wins.</div>

      <h2>How a case runs</h2>
      <ul>
        <li>You describe the problem; the agent extracts the objective and shows you a mandate — the exact list of things it's allowed to do.</li>
        <li>Within the mandate it drafts messages, follows up on schedule, and escalates through a fixed ladder (polite ask → policy cite → human escalation → supervisor → formal dispute draft → complaint draft).</li>
        <li>Dispute and complaint letters are always <strong>drafts for you to file</strong> — we generate them, you send them to your bank or the agency. We never file on your behalf.</li>
        <li>Results are counted conservatively: self-reported money is "received — customer confirmed"; only a document + your confirmation marks a case resolved-with-verification.</li>
      </ul>

      <h2>What we never do</h2>
      <ul>
        <li>Never press "send" inside a merchant chat — the companion extension drafts and (if you let it) prefills; the human clicks send.</li>
        <li>Never bypass CAPTCHAs, rate limits, or bot detection. Coverage that needs your logged-in browser is labeled "assisted" — you carry it.</li>
        <li>Never store your merchant passwords or session cookies.</li>
        <li>Never claim a result that isn't proven. Labels (implemented / verified / partial / designed) are written for auditors, not marketing.</li>
        <li>Never send system email through your personal mailbox.</li>
      </ul>

      <h2>Coverage honesty</h2>
      <p>Per-merchant lanes carry a verification tier. "Simulated" means the test merchant — a fake company we built for demos; it is always labeled, never counted as a real integration. Real lanes become "verified" only after a real case succeeds on that merchant.</p>
    </div>
  );
}

export function Disclaimer() {
  return (
    <div className="legal-page">
      <h1>Not legal advice</h1>
      <div className="muted-line">Read this before relying on anything Company Service produces.</div>
      <p>Company Service drafts communications and dispute letters from general templates and the facts you provide. We are not lawyers, we do not represent you, and nothing in the product — templates, deadline reminders, escalation suggestions, dispute letters — is legal advice.</p>
      <p>Card-dispute and agency-complaint templates reference frameworks like the Fair Credit Billing Act because that is what the letters are for — but whether they apply to your situation, and whether a deadline is real, is a question for a lawyer. When a case is genuinely disputed or the amount matters, get counsel.</p>
      <p>Deadlines shown in the product are bookkeeping reminders the merchant stated or the spec implies — they are never represented as statutory limits.</p>
    </div>
  );
}

export function VerifyResult({ ok }: { ok: boolean }) {
  return (
    <div className="legal-page" style={{ textAlign: "center" }}>
      <h1>{ok ? "Email verified" : "Verification link expired"}</h1>
      <p className="muted-line">
        {ok
          ? "You're all set — email-dependent features (sending to merchants, notifications) are now enabled."
          : "That link was already used or expired. Sign in and request a fresh one from Settings."}
      </p>
      <a className="btn btn-primary" href="#/app" style={{ display: "inline-block", textDecoration: "none", marginTop: 10 }}>
        {ok ? "Go to your cases" : "Sign in"}
      </a>
    </div>
  );
}

export function ReportAbuse() {
  const [email, setEmail] = useState("");
  const [caseId, setCaseId] = useState("");
  const [body, setBody] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { await api.reportAbuse(email, caseId, body); setSent(true); }
    catch (err: any) { setError(err.message); }
  }

  return (
    <div className="legal-page">
      <h1>Report abuse</h1>
      <p className="muted-line">
        If someone is using Company Service against you — spam, threats, false claims — tell us here. Every report is read.
      </p>
      {sent ? (
        <div className="notice-box">Got it — thanks. We investigate every report.</div>
      ) : (
        <form onSubmit={submit}>
          {error && <div className="error-box">{error}</div>}
          <div className="field">
            <label>Your email (optional but helps)</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label>Case ID or merchant (if known)</label>
            <input className="input" value={caseId} onChange={(e) => setCaseId(e.target.value)} placeholder="cs_... or merchant name" />
          </div>
          <div className="field">
            <label>What happened</label>
            <textarea className="input" rows={5} required value={body} onChange={(e) => setBody(e.target.value)} placeholder="The email I received said…" />
          </div>
          <button className="btn btn-primary">Send report</button>
        </form>
      )}
    </div>
  );
}
