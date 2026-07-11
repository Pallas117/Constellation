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

  const appHeading = page.getByRole("heading", { name: /gauss.*aurora/i });
  const sensorHeading = page.getByText(/gauss \/\/ sensor_array/i);
  const logicHeading = page.getByRole("heading", { name: /logic[_ ]engine/i });
  const themeTrigger = page.getByRole("button", { name: /current theme:/i });
  const earthLayerButton = page.getByRole("button", { name: /earth layer/i });
  const colorEncodingButton = page.getByRole("button", {
    name: /use color encoding for radiation flux/i,
  });
  const askButton = page.getByRole("button", { name: /exec_query_rag/i });

  await expect(appHeading).toBeVisible();
  await expect(sensorHeading).toBeVisible();
  await expect(logicHeading).toBeVisible();
  await expect(themeTrigger).toBeVisible();
  await expect(earthLayerButton).toBeVisible();
  await expect(colorEncodingButton).toBeVisible();
  await expect(askButton).toBeVisible();

  const criticalLocators = [
    appHeading,
    sensorHeading,
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
  await page.getByRole("menuitem", { name: /mode_drk/i }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(true);

  await page
    .getByPlaceholder(/\[ENTER_QUERY_INPUT\.\.\.\]/i)
    .fill("Mobile layout interaction test");
  await askButton.click();

  await expect(page.getByText(/synthetic answer from playwright mock/i)).toBeVisible();
});

