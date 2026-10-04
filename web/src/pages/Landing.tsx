export function Landing({ onCta }: { onCta: () => void }) {
  return (
    <main>
      <section className="hero">
        <span className="hero-kicker">AI consumer representation</span>
        <h1>
          They have <span>Customer&nbsp;Service</span>.<br />
          Now you have <span className="flipped">Company&nbsp;Service</span>.
        </h1>
        <p className="tagline">
          Tell your AI representative what went wrong. It handles supported chats,
          emails, and follow-ups for you — while you stay in control.
        </p>
        <div className="hero-cta">
          <button className="btn btn-primary" style={{ padding: "13px 26px", fontSize: 16 }} onClick={onCta}>
            Get it handled
          </button>
        </div>
        <p className="hero-sub"><em>Let your agent talk to their agent.</em></p>
      </section>

      <section className="how">
        <h2 style={{ textAlign: "center", letterSpacing: "-.01em" }}>How it works</h2>
        <div className="how-grid">
          <div className="how-card">
            <div className="num">01</div>
            <h3>Tell us what happened</h3>
            <p>Describe the problem the same way you'd tell a person — "Amazon never refunded my return."</p>
          </div>
          <div className="how-card">
            <div className="num">02</div>
            <h3>Give your agent permission</h3>
            <p>You choose exactly what Company Service can request, share, accept, and change.</p>
          </div>
          <div className="how-card">
            <div className="num">03</div>
            <h3>Let Company Service handle it</h3>
            <p>Your agent uses the best supported route and follows up automatically — even weeks later.</p>
          </div>
          <div className="how-card">
            <div className="num">04</div>
            <h3>Stay in control</h3>
            <p>Anything outside your instructions comes back to you for approval. You can pause or revoke anytime.</p>
          </div>
        </div>
      </section>

      <div className="truth-banner">
        <strong>Honest coverage:</strong> V1 focuses on online-retail post-purchase issues
        (refunds, returns, wrong/damaged/missing items). Coverage is shown per company
        and channel — simulated integrations are always labeled, never presented as real.
      </div>
    </main>
  );
}
