import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer; // snarkjs and tlock expect Node's Buffer

import "@fontsource-variable/inter";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/geist";
import "./styles.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Hub } from "./pages/Hub";
import { EloscapePage } from "./projects/eloscape/EloscapePage";
import { MontraPage } from "./projects/montra/MontraPage";

function useRoute() {
  // old links (/#/eloscape) still land on the right page, at the clean address
  if (/^#\/./.test(window.location.hash)) window.history.replaceState(null, "", "/" + window.location.hash.replace(/^#\/?/, ""));
  const read = () => window.location.pathname.replace(/^\/+|\/+$/g, "");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => (setRoute(read()), window.scrollTo(0, 0));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return route;
}

function App() {
  const route = useRoute();
  if (route === "eloscape") return <EloscapePage />;
  if (route === "montra") return <MontraPage />;
  return <Hub />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
