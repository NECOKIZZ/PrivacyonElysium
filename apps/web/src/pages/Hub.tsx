import { PROJECTS } from "../projects";
import { Footer, TopBar } from "./chrome";

export function Hub() {
  return (
    <div className="wrap">
      <TopBar />
      <section className="hero">
        <div className="eyebrow">An initiative by Cloak</div>
        <h1>Privacy on Elysium</h1>
        <p className="lede">
          Every move on Elysium is public: your wallet, your balance, your strategy. These pages let you use Elysium's apps from a private
          balance instead, so the app sees a fresh address and never your wallet.
        </p>
      </section>

      <div className="notice">
        <b>Independent and unofficial.</b> This site is built and run by Cloak, not by any project listed here. Their names and logos only
        show whose public contracts a page talks to; none of them runs, reviews or endorses it. Your plays go to their live contracts,
        under their rules and fees.
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

      <section className="how">
        <div>
          <h3>1 · Go private</h3>
          <p>Move HYPE into Gloam's shielded vault once. Inside it, balances are notes nobody can tie to you.</p>
        </div>
        <div>
          <h3>2 · Play from a fresh seat</h3>
          <p>Each play gets a one-time address funded by a zero-knowledge proof. The app sees that address, never your wallet.</p>
        </div>
        <div>
          <h3>3 · Come back private</h3>
          <p>Winnings return to your private balance as new notes. Cloak's relay sends every step, so your wallet never signs on chain.</p>
        </div>
      </section>
      <Footer />
    </div>
  );
}
