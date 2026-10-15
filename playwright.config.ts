import { defineConfig, devices } from "@playwright/test";

// PW_PORT lets the suite run beside the always-on services, which hold :8080.
const port = process.env.PW_PORT || "8080";
const baseURL = process.env.PW_BASE_URL || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
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
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_HELIO_PROXY_URL: "http://127.0.0.1:3001",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
