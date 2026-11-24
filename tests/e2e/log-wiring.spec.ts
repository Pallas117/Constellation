import { expect, test } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

// "Wire your logs" reads a customer's log in the browser: suggested mapping, row preview, mapping
// file and command. The file must never be uploaded, so the test fails on any unmocked request.

const USER = { id: "user-0001", email: "client@example.com", name: "Client", emailVerified: true, role: "user" };
const SESSION = {
  session: { id: "sess-0001", userId: USER.id, token: "mock", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), user: USER },
  user: USER,
};

test.beforeEach(async ({ page }) => {
  await mockUiApis(page);
  for (const pattern of ["**/get-session", "**/api/auth/get-session"]) {
    await page.route(pattern, (route) => {
      const origin = route.request().headers()["origin"] ?? "http://127.0.0.1";
      const headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(SESSION) });
    });
  }
});

test("the sample log maps itself, previews 5 of 7 rows and offers the mapping and command", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.method() !== "OPTIONS") posts.push(`${r.method()} ${r.url()}`);
  });
  await page.goto("/account/wire");
  await expect(page.getByRole("heading", { name: "Wire your logs" })).toBeVisible();
  await expect(page.getByText("is not uploaded")).toBeVisible();

  await page.getByRole("button", { name: "Try a sample" }).click();
  await expect(page.getByText("sample-log.csv", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Inference time")).toHaveValue("inference_time");
  await expect(page.getByLabel(/^Spacecraft · required/)).toHaveValue("sat");

  await expect(page.getByText("5 of 7 rows accepted")).toBeVisible();
  await expect(page.getByText("2 rows would be rejected, none silently")).toBeVisible();
  await expect(page.getByText(/duplicate of row 2/).first()).toBeVisible();
  await expect(page.getByText(/has no time zone/).first()).toBeVisible();

  // Confirming UTC turns the zone-less row from a rejection into an accepted row.
  await page.getByLabel("Times with no zone are UTC").check();
  await expect(page.getByText("6 of 7 rows accepted")).toBeVisible();

  await expect(page.getByRole("button", { name: "Download sample-log.mapping.json" })).toBeVisible();
  await expect(page.locator("pre")).toContainText("npm run trust:ingest -- 'sample-log.csv' 'sample-log.mapping.json' --replay jan-2026");
  expect(posts, "the wizard sends nothing").toEqual([]);
});

test("an unmapped required field blocks the run and says what to do", async ({ page }) => {
  await page.goto("/account/wire");
  await page.getByRole("button", { name: "Try a sample" }).click();
  await page.getByLabel("Inference time").selectOption("");
  await expect(page.getByText("Choose the column that holds the inference time.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Download .*mapping\.json/ })).toHaveCount(0);
});

test("a file that is not a log is refused in plain words", async ({ page }) => {
  await page.goto("/account/wire");
  await page.getByLabel("Choose a log file").setInputFiles({ name: "empty.csv", mimeType: "text/csv", buffer: Buffer.from("") });
  await expect(page.getByRole("alert")).toContainText("The file is empty.");
});
