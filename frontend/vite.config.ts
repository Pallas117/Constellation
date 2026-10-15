import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  root: __dirname,
  publicDir: path.resolve(__dirname, "./public"),
  server: {
    host: "127.0.0.1",
    port: 8080,
    strictPort: true,
    cors: false,
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
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
