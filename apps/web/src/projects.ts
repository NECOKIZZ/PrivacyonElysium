/**
 * The projects this site makes private. Each one lives in src/projects/<id>/ (its page) and projects/<id>/ at the repo
 * root (its integration, testable without the site). Adding one: a folder in both, and an entry here.
 *
 * Their names and logos only identify whose public contracts the page talks to. None of these projects runs, endorses
 * or is affiliated with this site.
 */
export interface ProjectCard {
  id: string;
  name: string;
  logo: string;
  logoBg: string;
  tagline: string;
  blurb: string;
  status: "live" | "soon";
  site: string;
}

export const PROJECTS: ProjectCard[] = [
  {
    id: "eloscape",
    name: "Eloscape",
    logo: "/projects/eloscape/logo.svg",
    logoBg: "#0d0d0f",
    tagline: "Stake HYPE on any block, privately.",
    blurb: "Mine Eloscape's grid without showing your wallet, your blocks or your size.",
    status: "live",
    site: "https://eloscape.com",
  },
  {
    id: "montra",
    name: "Montra",
    logo: "/projects/montra/logo.png",
    logoBg: "#0d0d0f",
    tagline: "Launch and hold tokens, privately.",
    blurb: "Launch on Montra without showing your wallet as the dev, and hold any Montra token privately with its holder rewards.",
    status: "live",
    site: "https://montramarkets.xyz",
  },
];
