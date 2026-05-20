import { expect, test } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

test.use({
  viewport: { width: 390, height: 844 },
});

test.beforeEach(async ({ page }) => {
  await mockUiApis(page);
});

test("mobile: layout and controls remain usable at 390x844", async ({ page }) => {
  await page.goto("/?e2e=1");

  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Viewport not available");

  const appHeading = page.getByRole("heading", { name: /gauss aurora/i });
  const dataFeedHeading = page.getByRole("heading", { name: /space weather/i });
  const logicHeading = page.getByRole("heading", { name: /logic engine/i });
  const themeTrigger = page.getByRole("button", { name: /current theme:/i });
  const earthLayerButton = page.getByRole("button", { name: /earth layer/i });
  const colorEncodingButton = page.getByRole("button", {
    name: /use color encoding for radiation flux/i,
  });
  const askButton = page.getByRole("button", { name: /ask gauss rag/i });

  await expect(appHeading).toBeVisible();
  await expect(dataFeedHeading).toBeVisible();
  await expect(logicHeading).toBeVisible();
  await expect(themeTrigger).toBeVisible();
  await expect(earthLayerButton).toBeVisible();
  await expect(colorEncodingButton).toBeVisible();
  await expect(askButton).toBeVisible();

  const criticalLocators = [
    appHeading,
    dataFeedHeading,
    logicHeading,
    themeTrigger,
    earthLayerButton,
    askButton,
  ];

  for (const locator of criticalLocators) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  }

  await earthLayerButton.click();
  await expect(earthLayerButton).toHaveAttribute("aria-pressed", "false");
  await earthLayerButton.click();
  await expect(earthLayerButton).toHaveAttribute("aria-pressed", "true");

  await themeTrigger.click();
  await page.getByRole("menuitem", { name: /dark/i }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(true);

  await page
    .getByPlaceholder(/ask gauss about mission concepts, threats, or documents/i)
    .fill("Mobile layout interaction test");
  await askButton.click();

  await expect(page.getByText(/synthetic answer from playwright mock/i)).toBeVisible();
});

