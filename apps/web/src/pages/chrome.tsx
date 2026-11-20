export function TopBar({ right }: { right?: React.ReactNode }) {
  return (
    <header className="top">
      <a className="brand" href="#/">
        <img src="/cloak-mark.svg" alt="" />
        <span>
          Privacy on Elysium <small>by Cloak</small>
        </span>
      </a>
      {right}
    </header>
  );
}

export function Footer() {
  return (
    <footer>
      <p style={{ margin: "0 0 6px" }}>
        Privacy on Elysium is an independent initiative by <a href="https://oncloak.xyz">Cloak</a>, built with Cloak's SDK on{" "}
        <a href="https://gloam.trade">Gloam</a>'s shielded vault. It is not affiliated with, run or endorsed by the projects it lists.
      </p>
      <p style={{ margin: 0 }}>
        Open source, MIT. Cloak's escrow contracts haven't had an external audit yet: play with amounts you can afford to lose.
      </p>
    </footer>
  );
}
