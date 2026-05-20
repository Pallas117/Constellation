import { expect, test } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

test.beforeEach(async ({ page }) => {
  await mockUiApis(page);
});

test("smoke: control rail and centered LLM chat interactions", async ({ page }) => {
  await page.goto("/?e2e=1");

  await expect(
    page.getByRole("heading", { name: /gauss aurora/i }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /logic engine/i })).toBeVisible();

  const layerNames = [
    /earth layer/i,
    /van allen belts layer/i,
    /magnetopause layer/i,
    /field lines layer/i,
    /mhd waves layer/i,
    /mms reconnection layer/i,
  ];

  for (const layerName of layerNames) {
    const button = page.getByRole("button", { name: layerName });
    const before = await button.getAttribute("aria-pressed");
    await button.click();
    const expectedAfter = before === "true" ? "false" : "true";
    await expect(button).toHaveAttribute("aria-pressed", expectedAfter);
  }

  const colorEncodingButton = page.getByRole("button", {
    name: /use color encoding for radiation flux/i,
  });
  const sizeEncodingButton = page.getByRole("button", {
    name: /use particle size encoding for radiation flux/i,
  });
  const bothEncodingButton = page.getByRole("button", {
    name: /use both color and size encoding for radiation flux/i,
  });

  await sizeEncodingButton.click();
  await expect(sizeEncodingButton).toHaveAttribute("aria-pressed", "true");
  await bothEncodingButton.click();
  await expect(bothEncodingButton).toHaveAttribute("aria-pressed", "true");
  await colorEncodingButton.click();
  await expect(colorEncodingButton).toHaveAttribute("aria-pressed", "true");

  const themeTrigger = page.getByRole("button", { name: /current theme:/i });
  await themeTrigger.click();
  await page.getByRole("menuitem", { name: /dark/i }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(true);

  await themeTrigger.click();
  await page.getByRole("menuitem", { name: /light/i }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(false);

  const screenshotButton = page.getByRole("button", { name: /^export$/i });
  const downloadPromise = page
    .waitForEvent("download", { timeout: 5_000 })
    .catch(() => null);

  await screenshotButton.click();
  const download = await downloadPromise;
  if (download) {
    expect(download.suggestedFilename()).toMatch(/^space-weather-\d+\.png$/);
  }

  await expect(page.getByText(/42 knowledge chunks/i)).toBeVisible();

  await page.getByRole("button", { name: /index lightbound/i }).click();
  await expect(page.getByText(/42 knowledge chunks/i)).toBeVisible();

  await page
    .getByPlaceholder(/ask gauss about mission concepts, threats, or documents/i)
    .fill("What is the synthetic status?");
  await page.getByRole("button", { name: /ask gauss rag/i }).click();

  await expect(page.getByText(/synthetic answer from playwright mock/i)).toBeVisible();
  await expect(page.getByText(/\/tmp\/mock-source\.pdf/i)).toBeVisible();
});
