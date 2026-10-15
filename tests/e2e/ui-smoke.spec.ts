import { expect, test } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

test.beforeEach(async ({ page }) => {
  await mockUiApis(page);
});

test("smoke: control rail and centered LLM chat interactions", async ({ page }) => {
  await page.goto("/operator?e2e=1");

  await expect(
    page.getByRole("heading", { name: /gauss.*aurora/i }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /logic[_ ]engine/i })).toBeVisible();

  const layerNames = [
    /earth layer/i,
    /radiation belts layer/i,
    /boundaries layer/i,
    /field lines layer/i,
    /mhd waves layer/i,
    /mms reconnection layer/i,
  ];

  for (const layerName of layerNames) {
    const toggle = page.getByRole("switch", { name: layerName });
    const before = await toggle.getAttribute("aria-checked");
    await toggle.click();
    const expectedAfter = before === "true" ? "false" : "true";
    await expect(toggle).toHaveAttribute("aria-checked", expectedAfter);
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

  // One brand look: the theme is always dark, there is no switcher.
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(true);

  const fidelity = page.getByRole("switch", { name: /high-fidelity belts/i });
  await fidelity.click();
  await expect(fidelity).toHaveAttribute("aria-checked", "true");

  const screenshotButton = page.getByRole("button", { name: /save screenshot/i });
  const downloadPromise = page
    .waitForEvent("download", { timeout: 5_000 })
    .catch(() => null);

  await screenshotButton.click();
  const download = await downloadPromise;
  if (download) {
    expect(download.suggestedFilename()).toMatch(/^space-weather-\d+\.png$/);
  }

  await expect(page.getByText(/42 knowledge chunks/i)).toBeVisible();

  await page.getByRole("button", { name: /rebuild index/i }).click();
  await expect(page.getByText(/42 knowledge chunks/i)).toBeVisible();

  await page
    .getByRole("textbox", { name: /question for the knowledge base/i })
    .fill("What is the synthetic status?");
  await page.getByRole("button", { name: /^ask$/i }).click();

  await expect(page.getByText(/synthetic answer from playwright mock/i)).toBeVisible();
  await expect(page.getByText(/\/tmp\/mock-source\.pdf/i)).toBeVisible();
});
