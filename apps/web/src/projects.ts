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
    tagline: "Stay HYPE on any block, privately.",
    blurb: "Mine Eloscape's 5×5 grid from a private balance. Hide who plays, which block until the last seconds, and how much.",
    status: "live",
    site: "https://eloscape.com",
  },
];
