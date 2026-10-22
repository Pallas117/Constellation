import { expect, test } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

// GAU-150: the 24 h history merges its backfill with the live points on mount. With neither
// there yet, mergeSeries threw and the error boundary replaced the whole page. The catch-all
// in mockUiApis answers the 5 s feed with 404, so the backfill fails and no live point arrives.
test("the heliophysics page survives the 5 s feed being down (GAU-150)", async ({ page }) => {
  await mockUiApis(page);
  await page.goto("/heliophysics?e2e=1");

  await page.getByRole("link", { name: /24 h history/i }).click();

  await expect(page.getByText("Couldn't load the 24 h history: not available on this server yet.")).toBeVisible();
  await expect(page.getByText("Something went wrong on this page.")).toHaveCount(0);
});
