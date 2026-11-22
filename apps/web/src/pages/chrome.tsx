export const REPO = "https://github.com/NECOKIZZ/PrivacyonElysium";
export const SDK_DOCS = "https://oncloak.xyz/docs";

/** In-app navigation without a page reload (clean paths, no #). */
export function go(e: React.MouseEvent, to: string) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function CloakMark() {
  return (
    <picture>
      <source srcSet="/cloak-mark-light.svg" media="(prefers-color-scheme: dark)" />
      <img src="/cloak-mark.svg" alt="" />
    </picture>
  );
}

export function TopBar({ right }: { right?: React.ReactNode }) {
  return (
    <header className="top">
      <a className="brand" href="/" onClick={(e) => go(e, "/")}>
        <CloakMark />
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
