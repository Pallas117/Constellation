// Where the Gauss backend API lives, from VITE_HELIO_PROXY_URL at build time:
//
// - "same-origin" (always-on install): the site and the API share one origin.
//   `vite preview` forwards /api and /ws to :3001 on this Mac, and
//   `tailscale serve` does the same on the tailnet, so one build works at
//   http://127.0.0.1:8080 and at the tailnet name. (An absolute tailnet URL
//   breaks on the Mac itself: macOS Tailscale doesn't loop its own share back.)
// - an absolute URL: that origin.
// - unset or empty: http://127.0.0.1:3001 (npm run dev).

const DEV_DEFAULT = "http://127.0.0.1:3001";

export type ApiBaseMode = { kind: "same-origin" } | { kind: "absolute"; url: string };

export function resolveApiBase(raw: string | undefined): ApiBaseMode {
  const value = (raw ?? "").trim();
  if (value === "same-origin") return { kind: "same-origin" };
  return { kind: "absolute", url: (value || DEV_DEFAULT).replace(/\/+$/, "") };
}

// Optional chaining keeps this importable under node:test, where import.meta.env is undefined.
const MODE = resolveApiBase(import.meta.env?.VITE_HELIO_PROXY_URL);

/** Prefix for API paths: "" when same-origin, else the absolute origin. Use as `${apiBase()}/api/...`. */
export function apiBase(): string {
  return MODE.kind === "same-origin" ? "" : MODE.url;
}

/** Absolute origin of the API (the page's own origin when same-origin). */
export function apiOrigin(): string {
  return MODE.kind === "same-origin" ? window.location.origin : new URL(MODE.url).origin;
}

/** WebSocket origin matching apiOrigin(): ws:// or wss://. */
export function wsOrigin(): string {
  return apiOrigin().replace(/^http/i, "ws");
}
