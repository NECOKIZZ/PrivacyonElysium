export const REPO = "https://github.com/NECOKIZZ/PrivacyonElysium";

export function TopBar({ right }: { right?: React.ReactNode }) {
  return (
    <header className="top">
      <a className="brand" href="#/">
        <img src="/cloak-mark.svg" alt="" />
        <span>Privacy on Elysium</span>
      </a>
      {right}
    </header>
  );
}

export function Footer() {
  return (
    <footer>
      <p style={{ margin: 0 }}>
        Built with <a href="https://oncloak.xyz">Cloak</a>'s SDK on <a href="https://gloam.trade">Gloam</a>'s shielded vault. Not affiliated with
        the projects it lists. Open source:{" "}
        <a href={REPO} target="_blank" rel="noreferrer">
          read the code
        </a>
        .
      </p>
    </footer>
  );
}
