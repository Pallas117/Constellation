import "./lib/api/backend-credentials";
import { createRoot } from "react-dom/client";
import App from "./Cybertiger.tsx";
// Fonts are served by this site, not Google: no visitor IP leaves for a third
// party and the page never waits on another host. SIL OFL 1.1; latin subset,
// only the weights the UI uses (font-display: swap).
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
