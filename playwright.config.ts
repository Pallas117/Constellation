import { defineConfig, devices } from "@playwright/test";

// PW_PORT lets the suite run beside the always-on services, which hold :8080.
const port = process.env.PW_PORT || "8080";
const baseURL = process.env.PW_BASE_URL || `http://127.0.0.1:${port}`;

// The suite tests a production build served by `vite preview`, as the always-on site is
// served: a page loads a few bundled chunks, so nothing compiles on demand while several
// workers load at once. (On the dev server, cold first renders overran the 10 s expect
// timeout under memory pressure, failing different tests each run.) PW_SERVER=dev uses the
// dev server instead, for quick iteration; it is not the gate.
//
// Hermetic either way: the API is same-origin and the server's /api and /ws proxy points at
// a closed port, so anything a test forgets to mock fails instead of reaching a real backend
// (the live one holds :3001, where CyberTiger counts 401/403s per IP).
const NO_BACKEND = "http://127.0.0.1:9";
const OUT_DIR = ".e2e/dist"; // under frontend/; ignored by git and ESLint, apart from `npm run build`'s dist
const server =
  process.env.PW_SERVER === "dev"
    ? `npm run dev -- --host 127.0.0.1 --port ${port}`
    : `npm run build -- --outDir ${OUT_DIR} --emptyOutDir --logLevel warn && ` +
      `npm run preview -- --outDir ${OUT_DIR} --host 127.0.0.1 --port ${port} --strictPort`;

// Under `argo guard run` (claude-heavy), ARGO_WORKERS is how many browsers this host can afford
// right now: 1 at memory warn. Without it, Playwright's default (half the logical cores).
const workers = Number(process.env.ARGO_WORKERS) || undefined;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: server,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000, // includes the production build
    env: {
      VITE_HELIO_PROXY_URL: "same-origin",
      GAUSS_API_TARGET: NO_BACKEND,
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // No internet: every host except the server under test fails to resolve at once. The
        // page's `load` event waits for the Google Fonts stylesheet (frontend/src/index.css); on a
        // slow link that request hung the first navigation of each worker past the 45 s test
        // timeout (2026-10-22, 4 of 12 failed). Pages fall back to system fonts; nothing leaves
        // the Mac. The rule matches IP literals too, so the server's host must be excluded.
        launchOptions: {
          args: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${new URL(baseURL).hostname}, EXCLUDE localhost`],
        },
      },
    },
  ],
});
