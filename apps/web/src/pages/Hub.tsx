import { PROJECTS } from "../projects";
import { Footer, REPO, TopBar } from "./chrome";

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
          <a key={p.id} className="pcard" href={`#/${p.id}`}>
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
        <div className="pcard ghost">
          <div className="tag">Your protocol, next.</div>
          <p className="muted small" style={{ margin: 0 }}>
            Building on Elysium and want privacy inside your own app, done properly? Talk to Cloak and we'll integrate it with you.
          </p>
          <div className="foot">
            <a href="https://x.com/cloakonelysium" target="_blank" rel="noreferrer">@cloakonelysium</a>
            <a href="https://t.me/cloakdesk" target="_blank" rel="noreferrer">t.me/cloakdesk</a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
