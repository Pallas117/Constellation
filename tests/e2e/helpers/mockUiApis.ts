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

export async function mockUiApis(page: Page): Promise<void> {
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "*",
  };

  const fulfillCorsJson = async (
    route: Parameters<Parameters<Page["route"]>[1]>[0],
    body: unknown,
    status = 200,
  ) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: corsHeaders,
      });
      return;
    }

    await route.fulfill({
      status,
      contentType: "application/json",
      headers: corsHeaders,
      body: JSON.stringify(body),
    });
  };

  await page.route("**/functions/v1/spaceweather**", async (route) => {
    await fulfillCorsJson(route, MOCK_SPACE_WEATHER);
  });

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

