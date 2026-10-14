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

  const encoding = page.getByRole("radiogroup", { name: /flux encoding/i });
  for (const name of [/^size$/i, /^both$/i, /^colour$/i]) {
    const option = encoding.getByRole("radio", { name });
    await option.click();
    await expect(option).toHaveAttribute("aria-checked", "true");
  }

  const hifiSwitch = page.getByRole("switch", { name: /high-fidelity belts/i });
  await hifiSwitch.click();
  await expect(hifiSwitch).toHaveAttribute("aria-checked", "true");

  const screenshotButton = page.getByRole("button", { name: /screenshot/i });
  const downloadPromise = page
    .waitForEvent("download", { timeout: 5_000 })
    .catch(() => null);

  await screenshotButton.click();
  const download = await downloadPromise;
  if (download) {
    expect(download.suggestedFilename()).toMatch(/^space-weather-\d+\.png$/);
  }

  await expect(page.getByText(/42 knowledge chunks/i)).toBeVisible();

  await page.getByRole("button", { name: /r_index_lgb/i }).click();
  await expect(page.getByText(/42 knowledge chunks/i)).toBeVisible();

  await page
    .getByPlaceholder(/\[ENTER_QUERY_INPUT\.\.\.\]/i)
    .fill("What is the synthetic status?");
  await page.getByRole("button", { name: /exec_query_rag/i }).click();

  await expect(page.getByText(/synthetic answer from playwright mock/i)).toBeVisible();
  await expect(page.getByText(/\/tmp\/mock-source\.pdf/i)).toBeVisible();
});
