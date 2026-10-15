import { expect, test } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

test.use({
  viewport: { width: 390, height: 844 },
});

test.beforeEach(async ({ page }) => {
  await mockUiApis(page);
});

test("mobile: layout and controls remain usable at 390x844", async ({ page }) => {
  await page.goto("/operator?e2e=1");

  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Viewport not available");

  // On a phone the console stacks: header, telemetry, scene, assistant, controls.
  const appHeading = page.getByRole("heading", { name: /gauss.*aurora/i });
  const telemetryHeading = page.getByRole("heading", { name: /solar_wind/i });
  const logicHeading = page.getByRole("heading", { name: /logic[_ ]engine/i });
  const earthLayer = page.getByRole("switch", { name: /earth layer/i });
  const colorEncodingButton = page.getByRole("button", {
    name: /use color encoding for radiation flux/i,
  });
  const askButton = page.getByRole("button", { name: /^ask$/i });

  // Header and live telemetry are in the first screen without scrolling.
  for (const locator of [appHeading, telemetryHeading]) {
    await expect(locator).toBeInViewport();
  }

  // Everything else is reachable by scrolling and fits the width.
  for (const locator of [appHeading, telemetryHeading, logicHeading, earthLayer, colorEncodingButton, askButton]) {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeInViewport();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await earthLayer.scrollIntoViewIfNeeded();
  await earthLayer.click();
  await expect(earthLayer).toHaveAttribute("aria-checked", "false");
  await earthLayer.click();
  await expect(earthLayer).toHaveAttribute("aria-checked", "true");

  await page
    .getByRole("textbox", { name: /question for the knowledge base/i })
    .fill("Mobile layout interaction test");
  await askButton.click();

  await expect(page.getByText(/synthetic answer from playwright mock/i)).toBeVisible();
});
