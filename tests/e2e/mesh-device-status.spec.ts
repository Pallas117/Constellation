import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

// The /mesh page's device status cards: battery, charger, security posture and report age per
// device, readable on a phone. Hermetic: the device list below is synthetic and shaped like
// MeshDeviceView (backend/mesh/store.ts); the names are examples, not real reports.

const shots = process.env.PW_SHOTS; // a directory: also save screenshots there (PR evidence)
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};

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

// Half a minute past the whole minute: the page's clock ticks every 30 s, and ages are floored.
const minsAgo = (m: number) => new Date(Date.now() - (m + 0.5) * 60_000).toISOString();

function report(minutes: number, extra: Record<string, unknown>) {
  return {
    class: "OK",
    reason: "",
    loc: "MY",
    tailscale: true,
    exitNode: "",
    breakerOpen: false,
    argoVersion: "0.0.0-e2e",
    checkedAt: minsAgo(minutes),
    receivedAt: minsAgo(minutes),
    ...extra,
  };
}

function devices() {
  const owner = "operator@example.test";
  return [
    {
      // On battery and low, with one security check that needs a look.
      name: "judith",
      enrolledAt: minsAgo(9000),
      owner,
      hosting: "no",
      hostingWhy: ["battery 18% on battery power"],
      last: report(2, {
        platform: "macos",
        battery: { level: 18, charging: false, lowPower: true, external: false, power: { mode: "eclipse", sourceW: 0, loadW: 14, marginW: -14 } },
        posture: { at: minsAgo(40), items: { disk: "ok", firewall: "warn", updates: "ok", integrity: "ok", tailkey: "ok", argo: "ok", sharing: "unknown" } },
      }),
    },
    {
      // Plugged into a 5 V USB port: charging, but slowly. No battery trouble, all checks pass.
      name: "talos",
      enrolledAt: minsAgo(9000),
      owner,
      hosting: "light",
      last: report(4, {
        platform: "linux",
        battery: { level: 64, charging: true, lowPower: false, external: true, charger: { state: "no-pd", volts: 5, watts: 7.5 } },
        posture: { at: minsAgo(55), items: { disk: "ok", firewall: "ok", updates: "ok", integrity: "ok", tailkey: "ok", argo: "ok", sharing: "ok" } },
      }),
    },
    {
      // Reporting, but the report carries no battery and no posture.
      name: "desk-node",
      enrolledAt: minsAgo(9000),
      owner: "staff@example.test",
      hosting: "agents",
      last: report(1, { platform: "linux" }),
    },
    {
      // Last heard three hours ago: its numbers are last known, not current.
      name: "argo-phone",
      enrolledAt: minsAgo(9000),
      owner,
      hosting: "no",
      last: report(185, { platform: "ios", battery: { level: 9, charging: false, lowPower: true } }),
    },
    // Enrolled long ago, never reported.
    { name: "spare-laptop-with-a-long-device-name", enrolledAt: minsAgo(9000), owner },
  ];
}

/** An operator's view of the team; returns the paths the page asked for. */
async function mockMesh(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.route("**/api/mesh/**", async (route) => {
    const request = route.request();
    const headers = corsHeaders(route);
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    seen.push(`${request.method()} ${path}`);
    if (path.endsWith("/onboarding")) {
      return route.fulfill({ status: 200, headers, json: { steps: [], canEnroll: true, canSeeTeam: true, canRevokeAny: true, me: "operator@example.test" } });
    }
    if (path.endsWith("/devices") && request.method() === "GET") return route.fulfill({ status: 200, headers, json: { devices: devices() } });
    return route.fulfill({ status: 404, headers });
  });
  return seen;
}

const card = (page: Page, name: string) => page.getByTestId(`device-card-${name}`);

async function expectCards(page: Page) {
  await expect(page.getByRole("heading", { name: "Power and security" })).toBeVisible();

  const judith = card(page, "judith");
  await expect(judith).toContainText("macOS · No spare capacity");
  await expect(judith).toContainText("Reporting");
  await expect(judith).toContainText("Last report 2 min ago");
  await expect(judith).toContainText("18%");
  await expect(judith).toContainText("Low · on battery");
  await expect(judith).toContainText("Low power mode on");
  await expect(judith.getByRole("meter", { name: "judith battery level" })).toHaveAttribute("aria-valuenow", "18");
  await expect(judith).toContainText("5/7checks ok");
  await expect(judith).toContainText("Warning: firewall");
  await expect(judith).toContainText("Not read: sharing services");
  await expect(judith).toContainText("Checked 40 min ago");

  const talos = card(page, "talos");
  await expect(talos).toContainText("Weak charger");
  await expect(talos).toContainText("5 V USB, no fast charging (7.5 W)");
  await expect(talos).toContainText("All ok");

  // No battery and no posture in the report: a dash and "Not reported", never a level.
  const desk = card(page, "desk-node");
  await expect(desk).toContainText("Linux · Agents + memory");
  await expect(desk.getByText("Not reported")).toHaveCount(2);
  await expect(desk.getByText("—", { exact: true })).toHaveCount(2);
  await expect(desk.getByRole("meter")).toHaveCount(0);
  await expect(desk).not.toContainText("%");

  // Stale: said in words, with the age, and its numbers marked as last known.
  const phone = card(page, "argo-phone");
  await expect(phone).toContainText("Stale");
  await expect(phone).toContainText("Last report 3 h ago");
  await expect(phone).toContainText("Battery · last known");
  await expect(phone).toContainText("Critical · on battery");
  await expect(phone).toContainText("iPhone · Status only");

  const spare = card(page, "spare-laptop-with-a-long-device-name");
  await expect(spare).toContainText("No report");
  await expect(spare).toContainText("Last report —");
}

test("device status cards show battery, charger, security and report age per device", async ({ page }) => {
  await mockUiApis(page);
  const seen = await mockMesh(page);
  await page.goto("/mesh");

  await expectCards(page);
  // The cards draw from the list the page already polls: no route of their own.
  expect([...new Set(seen)].sort()).toEqual(["GET /api/mesh/devices", "GET /api/mesh/onboarding"]);
  await shot(page, "mesh-device-status-desktop");
});

test.describe("on a phone (375 px)", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the cards stack and the page does not scroll sideways", async ({ page }) => {
    await mockUiApis(page);
    await mockMesh(page);
    await page.goto("/mesh");

    await expectCards(page);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // One column, each card inside the screen.
    const boxes = await page.locator('[data-testid^="device-card-"]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
    expect(boxes).toHaveLength(5);
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(375);
    }
    for (let i = 1; i < boxes.length; i += 1) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom);
    await shot(page, "mesh-device-status-375");
  });
});
