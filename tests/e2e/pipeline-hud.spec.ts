import { expect, test, type Page } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

// The HUD must show what the backend pipeline reports (GAU-110): the verdict, the real data age
// and the slowest stage. Stale or missing telemetry must never render as fresh.

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: new Date().toISOString(),
    status: "fresh",
    tickIntervalMs: 5000,
    ticks: 42,
    skippedTicks: 0,
    lastTickAt: new Date().toISOString(),
    lastTickAgeMs: 500,
    dataTimestamp: new Date(Date.now() - 60_000).toISOString(),
    dataAgeMs: 60_000,
    freshMs: 600_000,
    maxAgeMs: 900_000,
    stages: [
      { stage: "tick", lastMs: 900, p50Ms: 400, p95Ms: 1200, maxMs: 1300, budgetMs: 5000, overBudget: false, samples: 42, errors: 0, timeouts: 0, lastAt: "" },
      { stage: "noaa", lastMs: 850, p50Ms: 800, p95Ms: 900, maxMs: 950, budgetMs: 8000, overBudget: false, samples: 4, errors: 0, timeouts: 0, lastAt: "" },
      { stage: "aurora-grid", lastMs: 35, p50Ms: 34, p95Ms: 40, maxMs: 90, budgetMs: 1000, overBudget: false, samples: 42, errors: 0, timeouts: 0, lastAt: "" },
    ],
    ...overrides,
  };
}

async function servePipeline(page: Page, body: unknown, status = 200) {
  await page.route("**/api/system/pipeline", (route) => {
    // Backend fetches carry credentials (lib/api/backend-credentials.ts), and browsers reject
    // credentialed responses that use "*". Echo the caller's origin, as mockUiApis does.
    const origin = route.request().headers()["origin"] ?? "http://127.0.0.1";
    const headers = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      Vary: "Origin",
    };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    return route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
  });
}

const hud = (page: Page) => page.getByRole("region", { name: "05_DATA_PATH" });

// Better Auth returns `{ session, user }`; ProtectedRoute reads `data.user` and /operator needs
// the operator role, otherwise the guard sends the page to "/".
const USER = { id: "user-op-0001", email: "operator@gauss.space", name: "Operator Gauss", emailVerified: true, role: "operator" };
const SESSION = {
  session: { id: "sess-op-0001", userId: USER.id, token: "mock", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), user: USER },
  user: USER,
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); // the HUD is xl-only
  await mockUiApis(page);
  // Registered after mockUiApis, so these handlers take precedence.
  for (const pattern of ["**/get-session", "**/api/auth/get-session"]) {
    await page.route(pattern, (route) => {
      // Better Auth fetches with credentials, and browsers reject `*` for credentialed CORS,
      // so echo the page origin.
      const origin = route.request().headers()["origin"] ?? "http://127.0.0.1";
      const headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(SESSION) });
    });
  }
});

test("HUD shows the backend pipeline verdict, data age and slowest stage", async ({ page }) => {
  await servePipeline(page, snapshot());
  await page.goto("/operator?e2e=1");
  const panel = hud(page);
  await expect(panel).toContainText("FRESH");
  await expect(panel).toContainText(/1m0\ds/); // data age keeps ageing between polls
  await expect(panel).toContainText("NOAA 850ms");
  await expect(panel).toContainText("900ms / p95 1.2s");
  await expect(panel).not.toContainText("2.4 MB/S");
});

test("HUD shows STALE when the backend says the data expired", async ({ page }) => {
  await servePipeline(page, snapshot({ status: "stale", dataAgeMs: 1_200_000 }));
  await page.goto("/operator?e2e=1");
  const panel = hud(page);
  await expect(panel).toContainText("STALE");
  await expect(panel).not.toContainText("FRESH");
});

test("HUD shows NO_TELEMETRY, not a healthy pipeline, when the endpoint fails", async ({ page }) => {
  await servePipeline(page, { error: "down" }, 503);
  await page.goto("/operator?e2e=1");
  const panel = hud(page);
  await expect(panel).toContainText("NO_TELEMETRY");
  await expect(panel).not.toContainText("FRESH");
});
