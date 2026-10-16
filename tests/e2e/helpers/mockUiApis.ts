import type { Page } from "@playwright/test";

const MOCK_SPACE_WEATHER = {
  timestamp: new Date().toISOString(),
  solarWind: {
    speed: 425,
    density: 5.5,
    pressure: 2.4,
  },
  imf: {
    bz: -6.2,
    bt: 7.4,
  },
  particles: {
    protonFlux: 1.8,
    electronFlux: 2100,
  },
  indices: {
    kp: 4,
    dst: -40,
  },
  flags: {
    stale: false,
    source: "live",
    lastUpdate: new Date().toISOString(),
  },
};

// What GET /api/feed/space-weather/latest really returns: one canonical point.
const MOCK_CANONICAL_POINT = {
  timestamp: new Date().toISOString(),
  observedAt: new Date().toISOString(),
  source: "fusion",
  rho: 5.5,
  velocity: { x: -425, y: 0, z: 0, magnitude: 425 },
  magneticField: { x: 2.1, y: -3.4, z: -6.2, bt: 7.4 },
  solarWind: { speed: 425, density: 5.5, dynamicPressure: 2.4 },
  indices: { kp: 4, dst: -40, kpKind: "estimated-1m" },
  quality: { outlier: false, stale: false, interpolated: false, extrapolated: false, lowConfidence: false, tier: 0 },
};

const MOCK_CONNECTIVITY_STATUS = {
  mode: "CLOUD",
  latencyMs: 24,
  lastChecked: new Date().toISOString(),
};

const MOCK_ANOMALY_FORECAST = {
  modelVersion: "anomaly-v1",
  generatedAt: new Date().toISOString(),
  horizonHours: 72,
  anomalyProbability: 0.08,
  predictedKpMax: 4.0,
  warningMessage: "Nominal magnetospheric conditions detected.",
  confidenceInterval: [0.02, 0.15],
};

const MOCK_AUTH_SESSION = {
  session: {
    id: "sess-op-0001",
    userId: "user-op-0001",
    token: "mock-session-token",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    ipAddress: null,
    userAgent: null,
  },
  user: {
    id: "user-op-0001",
    email: "operator@gauss.space",
    emailVerified: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: "Operator Gauss",
    image: null,
    // /operator needs minRole "operator"; without a role the guard sends us to "/".
    role: "operator",
  },
};

export async function mockUiApis(page: Page, options?: { auth?: boolean }): Promise<void> {
  // The auth client sends credentials, and browsers reject credentialed
  // responses that use "*". Echo the caller's origin instead.
  const corsHeadersFor = (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
    const origin = route.request().headers()["origin"];
    return {
      "access-control-allow-origin": origin ?? "*",
      ...(origin ? { "access-control-allow-credentials": "true", vary: "Origin" } : {}),
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    };
  };

  const fulfillCorsJson = async (
    route: Parameters<Parameters<Page["route"]>[1]>[0],
    body: unknown,
    status = 200,
  ) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: corsHeadersFor(route),
      });
      return;
    }

    await route.fulfill({
      status,
      contentType: "application/json",
      headers: corsHeadersFor(route),
      body: JSON.stringify(body),
    });
  };

  // Hermetic: anything not mocked below gets a 404 here instead of reaching a real
  // backend (the dev proxy points at :3001, where CyberTiger counts 401/403s per IP).
  // Registered first, so every specific mock below takes precedence.
  await page.route(
    (url) => /^\/(api|ws|functions)\//.test(url.pathname),
    async (route) => {
      await fulfillCorsJson(route, { error: "not mocked" }, 404);
    },
  );

  await page.route("**/api/feed/space-weather/latest", async (route) => {
    await fulfillCorsJson(route, MOCK_CANONICAL_POINT);
  });

  await page.route("**/functions/v1/spaceweather**", async (route) => {
    await fulfillCorsJson(route, MOCK_SPACE_WEATHER);
  });

  await page.route("**/api/system/connectivity", async (route) => {
    await fulfillCorsJson(route, MOCK_CONNECTIVITY_STATUS);
  });

  await page.route("**/api/forecast/anomaly", async (route) => {
    await fulfillCorsJson(route, MOCK_ANOMALY_FORECAST);
  });

  if (options?.auth ?? true) {
    await page.route("**/get-session", async (route) => {
      await fulfillCorsJson(route, MOCK_AUTH_SESSION);
    });

    await page.route("**/api/auth/get-session", async (route) => {
      await fulfillCorsJson(route, MOCK_AUTH_SESSION);
    });

    await page.route("**/sign-in/email", async (route) => {
      await fulfillCorsJson(route, MOCK_AUTH_SESSION);
    });

    await page.route("**/api/auth/sign-in/email", async (route) => {
      await fulfillCorsJson(route, MOCK_AUTH_SESSION);
    });
  }

  await page.route("**/api/rag/status**", async (route) => {
    await fulfillCorsJson(route, { ok: true, chunkCount: 42 });
  });

  await page.route("**/api/rag/index**", async (route) => {
    await fulfillCorsJson(route, { ok: true });
  });

  await page.route("**/api/rag/query**", async (route) => {
    await fulfillCorsJson(route, {
      ok: true,
      answer: "Synthetic answer from Playwright mock.",
      sources: [{ filePath: "/tmp/mock-source.pdf", score: 0.98 }],
    });
  });
}

