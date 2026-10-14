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
  const sensorHeading = page.getByText(/02_solar_wind/i);
  const logicHeading = page.getByRole("heading", { name: /logic[_ ]engine/i });
  const hifiSwitch = page.getByRole("switch", { name: /high-fidelity belts/i });
  const earthLayerButton = page.getByRole("switch", { name: /earth layer/i });
  const colorEncodingButton = page.getByRole("radio", { name: /^colour$/i });
  const askButton = page.getByRole("button", { name: /exec_query_rag/i });

  await expect(appHeading).toBeVisible();
  await expect(sensorHeading).toBeVisible();
  await expect(logicHeading).toBeVisible();
  await expect(hifiSwitch).toBeVisible();
  await expect(earthLayerButton).toBeVisible();
  await expect(colorEncodingButton).toBeVisible();
  await expect(askButton).toBeVisible();

  const criticalLocators = [
    appHeading,
    sensorHeading,
    logicHeading,
    hifiSwitch,
    earthLayerButton,
    askButton,
  ];

  // On a phone the console is one scrolling column: each control must fit the
  // width and come fully on screen when scrolled to.
  for (const locator of criticalLocators) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  }

  await earthLayerButton.click();
  await expect(earthLayerButton).toHaveAttribute("aria-checked", "false");
  await earthLayerButton.click();
  await expect(earthLayerButton).toHaveAttribute("aria-checked", "true");

  await hifiSwitch.click();
  await expect(hifiSwitch).toHaveAttribute("aria-checked", "true");

  await page
    .getByPlaceholder(/\[ENTER_QUERY_INPUT\.\.\.\]/i)
    .fill("Mobile layout interaction test");
  await askButton.click();

  await expect(page.getByText(/synthetic answer from playwright mock/i)).toBeVisible();
});

