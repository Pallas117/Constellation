import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// `gauss-services.sh dev` runs a dev checkout beside the live install: it moves the
// dev server off :8080 (GAUSS_DEV_WEB_PORT) and points /api and /ws at the dev
// backend (GAUSS_API_TARGET), so development never reaches the live backend.
const API_TARGET = process.env.GAUSS_API_TARGET || "http://127.0.0.1:3001";

// GitHub Codespaces forwards the dev server as https://<codespace>-8080.app.github.dev
// (private: only the codespace's owner can open it). Vite refuses Host names it
// doesn't know, so allow that domain, and only inside a codespace.
const CODESPACES_HOSTS =
  process.env.CODESPACES === "true"
    ? [`.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev"}`]
    : undefined;

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  root: __dirname,
  publicDir: path.resolve(__dirname, "./public"),
  server: {
    host: "127.0.0.1",
    port: Number(process.env.GAUSS_DEV_WEB_PORT || 8080),
    strictPort: true,
    cors: false,
    allowedHosts: CODESPACES_HOSTS,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: false },
      "/ws": { target: API_TARGET.replace(/^http/, "ws"), ws: true, changeOrigin: false },
    },
  },
  // Always-on install (scripts/ops/gauss-services.sh): served on loopback only,
  // and shared with the tailnet through `tailscale serve`, which sends the
  // tailnet hostname. Allow tailnet names; nothing else can reach 127.0.0.1.
  preview: {
    host: "127.0.0.1",
    port: 8080,
    strictPort: true,
    allowedHosts: [".ts.net"],
    // Same-origin API (VITE_HELIO_PROXY_URL=same-origin, see lib/api/base-url.ts):
    // forward /api and /ws to the backend so http://127.0.0.1:8080 works on this
    // Mac too. tailscale serve does the same for the tailnet name. The Host
    // header is kept so the backend sees the origin the browser used. The live
    // install leaves GAUSS_API_TARGET unset (:3001); the e2e suite points it at
    // a closed port so no test can reach a real backend.
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: false },
      "/ws": { target: API_TARGET.replace(/^http/, "ws"), ws: true, changeOrigin: false },
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
