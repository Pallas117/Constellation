import { expect, test } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

// GAU-154: the operator console lists the L1 structure candidates (GAU-139) with their confidence,
// and says plainly that they are candidates, not confirmed events.
const now = new Date();
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const empty = { shocks: [], fieldOnlyDiscontinuities: [], sustainedSouthward: [], magnetopauseInsideGeo: [], icmeCandidates: [], fastFlows: [] };

test("operator console shows L1 structure candidates with confidence, as candidates (GAU-154)", async ({ page }) => {
  await mockUiApis(page);
  await page.route("**/api/swx/structures", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: at(0),
        spacecraft: "SOLAR1",
        from: at(1440),
        to: at(1),
        structures: {
          ...empty,
          shocks: [{ kind: "fast-forward shock candidate", time: at(90), earthArrival: at(55), shockSpeedKmS: 720, deltaSpeedKmS: 180, densityRatio: 2, fieldRatio: 2.2, confidence: "medium" }],
          coverage: { speed: 1, density: 1, bt: 1, bz: 1, temperature: 1 },
          notes: [],
        },
      }),
    }),
  );
  await page.goto("/operator?e2e=1");

  const pill = page.getByRole("button", { name: /^L1: 1 candidate · shock/ });
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(page.getByText("L1 structure candidates, last 24 h")).toBeVisible();
  await expect(page.getByText(/medium confidence/)).toBeVisible();
  await expect(page.getByText(/not confirmed events/)).toBeVisible();
});
