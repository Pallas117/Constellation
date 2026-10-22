import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import { readFileSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { componentTagger } from "lovable-tagger";

const require = createRequire(import.meta.url);

// The self-hosted fonts (src/main.tsx) are SIL OFL 1.1, which asks that the
// licence travel with the font files: ship each family's licence beside them.
const fontLicences = (): Plugin => ({
  name: "font-licences",
  apply: "build",
  generateBundle() {
    for (const family of ["ibm-plex-sans", "jetbrains-mono"]) {
      this.emitFile({
        type: "asset",
        fileName: `assets/${family}-OFL.txt`,
        source: readFileSync(require.resolve(`@fontsource/${family}/LICENSE`)),
      });
    }
  },
});

// `gauss-services.sh dev` runs a dev checkout beside the live install: it moves the
// dev server off :8080 (GAUSS_DEV_WEB_PORT) and points /api and /ws at the dev
// backend (GAUSS_API_TARGET), so development never reaches the live backend.
const API_TARGET = process.env.GAUSS_API_TARGET || "http://127.0.0.1:3001";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  root: __dirname,
  publicDir: path.resolve(__dirname, "./public"),
  server: {
    host: "127.0.0.1",
    port: Number(process.env.GAUSS_DEV_WEB_PORT || 8080),
    strictPort: true,
    cors: false,
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
    // header is kept so the backend sees the origin the browser used.
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: false },
      "/ws": { target: "ws://127.0.0.1:3001", ws: true, changeOrigin: false },
    },
  },
  plugins: [react(), fontLicences(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
