import { expect, test, type Page, type Route } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

// GAU-149: a refused revoke must say so. useMesh().revoke used to ignore the response, so a 403
// looked exactly like a successful revoke while the device kept its mesh access.

const SERVER_DETAIL = "server detail that must not be shown";

function corsHeaders(route: Route) {
  // Mesh calls carry credentials, and browsers reject credentialed responses that use "*".
  const origin = route.request().headers()["origin"] ?? "http://127.0.0.1";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    Vary: "Origin",
  };
}

/** One operator-visible device; DELETE answers with `deleteStatus`. Returns a DELETE counter. */
async function mockMesh(page: Page, deleteStatus: number): Promise<() => number> {
  let deletes = 0;
  await page.route("**/api/mesh/**", async (route) => {
    const request = route.request();
    const headers = corsHeaders(route);
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (path.endsWith("/onboarding")) {
      return route.fulfill({
        status: 200,
        headers,
        json: { steps: [], canEnroll: true, canSeeTeam: true, canRevokeAny: true, me: "operator@example.test" },
      });
    }
    if (path.endsWith("/devices") && request.method() === "GET") {
      return route.fulfill({
        status: 200,
        headers,
        json: { devices: [{ name: "laptop-a", enrolledAt: new Date().toISOString(), owner: "operator@example.test" }] },
      });
    }
    if (request.method() === "DELETE") {
      deletes += 1;
      if (deleteStatus === 204) return route.fulfill({ status: 204, headers });
      return route.fulfill({ status: deleteStatus, headers, json: { error: SERVER_DETAIL } });
    }
    return route.fulfill({ status: 404, headers });
  });
  return () => deletes;
}

test("a refused revoke shows an error instead of looking like it worked (GAU-149)", async ({ page }) => {
  await mockUiApis(page);
  const deletes = await mockMesh(page, 403);
  await page.goto("/mesh");

  await page.getByRole("button", { name: "Revoke" }).click();

  await expect(page.getByRole("alert")).toHaveText("Couldn't revoke the device: your role doesn't include this.");
  await expect(page.getByText(SERVER_DETAIL)).toHaveCount(0);
  expect(deletes()).toBe(1);
});

test("a successful revoke shows no error (GAU-149)", async ({ page }) => {
  await mockUiApis(page);
  const deletes = await mockMesh(page, 204);
  await page.goto("/mesh");

  await page.getByRole("button", { name: "Revoke" }).click();

  await expect.poll(deletes).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
