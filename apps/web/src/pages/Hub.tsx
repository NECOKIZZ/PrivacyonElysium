import { PROJECTS } from "../projects";
import { CloakMark, Footer, REPO, SDK_DOCS, TopBar, go } from "./chrome";

export function Hub() {
  return (
    <div className="wrap">
      <TopBar />
      <section className="hero">
        <h1>Privacy on Elysium</h1>
        <p className="lede">
          Use Elysium dApps privately, from your private balance. Your HYPE sits in Gloam's shielded vault, and the dApp sees a fresh
          address, never your wallet.
        </p>
      </section>

      <div className="notice">
        <b>Independent and unofficial.</b> Not run or endorsed by the projects listed. Their logos only show which contracts a page talks to.
        Verify the code before you use it:{" "}
        <a href={REPO} target="_blank" rel="noreferrer">
          github.com/NECOKIZZ/PrivacyonElysium
        </a>
        .
      </div>

      <section className="grid-cards">
        {PROJECTS.map((p) => (
          <a key={p.id} className="pcard" href={`/${p.id}`} onClick={(e) => go(e, `/${p.id}`)}>
            <div className="row">
              <div className="logo" style={{ background: p.logoBg }}>
                <img src={p.logo} alt={`${p.name} logo`} />
              </div>
              <span className={`pill ${p.status === "live" ? "live" : ""}`}>{p.status === "live" ? "● Private mode live" : "Soon"}</span>
            </div>
            <div>
              <div className="muted small">{p.name}</div>
              <div className="tag">{p.tagline}</div>
            </div>
            <p className="muted small" style={{ margin: 0 }}>{p.blurb}</p>
            <div className="foot">
              <span>Not run by {p.name}</span>
              <span>Enter →</span>
            </div>
          </a>
        ))}
        <div className="pcard sdk">
          <div className="row">
            <div className="logo">
              <CloakMark />
            </div>
            <span className="pill">Cloak SDK</span>
          </div>
          <div className="tag">Add private mode to your dApp.</div>
          <p className="muted small" style={{ margin: 0 }}>
            Every page here is built on the Cloak SDK: private balances, private calls to any contract, sealed plays. On-device proofs, a relay
            that sends for the user. A few lines in your own app.
          </p>
          <div className="foot">
            <a href={SDK_DOCS} target="_blank" rel="noreferrer">Read the SDK docs →</a>
            <a href="https://t.me/cloakdesk" target="_blank" rel="noreferrer">Talk to Cloak</a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
