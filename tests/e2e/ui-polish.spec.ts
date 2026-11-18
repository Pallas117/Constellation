import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

// UI polish regressions (Nov 2026 walk of the pilot flow): nothing in the console moves when data
// arrives, toasts don't take the first Tab stop, the landing fade is CSS that reduced motion stops,
// the mesh table keeps device names whole, and no page calls a route its viewer's role can't use
// (CyberTiger counts 401/403s per IP and blocks it).

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Holds a route's answer until `release()`; the page sees a slow feed. */
async function holdRoute(page: Page, pattern: string, body: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(pattern, async (route) => {
    await gate;
    await json(route, body);
  });
  return release;
}

const NO_STRUCTURES = {
  generatedAt: new Date().toISOString(),
  spacecraft: "SOLAR1",
  from: new Date(Date.now() - 86_400_000).toISOString(),
  to: new Date().toISOString(),
  structures: {
    shocks: [],
    fieldOnlyDiscontinuities: [],
    sustainedSouthward: [],
    magnetopauseInsideGeo: [],
    icmeCandidates: [],
    fastFlows: [],
    coverage: { speed: 1, density: 1, bt: 1, bz: 1, temperature: 1 },
    notes: [],
  },
};
const ONBOARDING = { steps: [{ id: "argo", title: "Install Argo", detail: "On the laptop." }], canEnroll: true, canSeeTeam: true, canRevokeAny: true, me: "operator@gauss.space" };
const DEVICES = { devices: [{ name: "laptop-alpha", enrolledAt: new Date().toISOString(), owner: "operator@gauss.space" }] };

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`console header keeps its height while its pills load (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockUiApis(page);
    const releaseStructures = await holdRoute(page, "**/api/swx/structures", NO_STRUCTURES);
    const releaseOnboarding = await holdRoute(page, "**/api/mesh/onboarding", ONBOARDING);
    await page.route("**/api/mesh/devices", (route) => json(route, DEVICES));

    await page.goto("/operator?e2e=1");
    const header = page.locator("header").filter({ has: page.getByRole("heading", { name: "Gauss Aurora" }) });
    await expect(header).toBeVisible();
    // While loading, each pill's place is held by a placeholder that says so.
    await expect(page.getByText("L1: checking…")).toBeVisible();
    await expect(page.getByText("Mesh: checking…")).toBeVisible();
    const before = await header.boundingBox();

    releaseStructures();
    releaseOnboarding();
    await expect(page.getByRole("button", { name: /^L1: no candidates/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /^Mesh: / })).toBeVisible();
    await expect(page.getByTestId("pill-placeholder")).toHaveCount(0);
    const after = await header.boundingBox();

    expect(before && after).toBeTruthy();
    expect(after!.height).toBeCloseTo(before!.height, 0); // same height, to sub-pixel rounding
  });
}

test("telemetry rows are one height with or without a status word", async ({ page }) => {
  await mockUiApis(page);
  await page.goto("/operator?e2e=1");
  const panel = page.getByRole("region", { name: "03_SOLAR_WIND" });
  // The mock's Bz (-6.2 nT) and Kp (4) carry status words; speed and density don't.
  await expect(panel.getByText("Southward", { exact: false })).toBeVisible();
  // A badge row is 22 px of pill + 12 px padding + the 1 px rule; plain rows reserve the same.
  const heights = await panel.locator("dl > div").evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().height)));
  expect(heights.length).toBeGreaterThan(3);
  expect(new Set(heights).size).toBe(1);
});

test("the storm forecast banner is one height while computing and when it lands", async ({ page }) => {
  await mockUiApis(page);
  const release = await holdRoute(page, "**/api/forecast/anomaly", {
    modelVersion: "anomaly-v1",
    generatedAt: new Date().toISOString(),
    horizonHours: 72,
    anomalyProbability: 0.08,
    predictedKpMax: 4,
    warningMessage: "Nominal magnetospheric conditions detected.",
    confidenceInterval: [0.02, 0.15],
  });
  await page.goto("/operator?e2e=1");
  const banner = page.getByTestId("forecast-banner");
  await expect(banner).toContainText("computing");
  const before = await banner.boundingBox();
  release();
  await expect(banner).toContainText("72 h forecast");
  const after = await banner.boundingBox();
  // The column is anchored at the bottom: a taller banner pushed the assistant up.
  expect(after!.height).toBeCloseTo(before!.height, 0);
});

test("the first Tab on the console reaches the page, not a toast", async ({ page }) => {
  await mockUiApis(page);
  await page.goto("/operator?e2e=1");
  // The mock's conditions raise the "Elevated geomagnetic risk" toast.
  await expect(page.getByText("Elevated geomagnetic risk")).toBeVisible();
  await page.locator("body").focus();
  await page.keyboard.press("Tab");
  const inMain = await page.evaluate(() => Boolean(document.activeElement?.closest("main")));
  expect(inMain).toBe(true);
});

test("landing fades in with CSS, and reduced motion shows it at once", async ({ browser }) => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const context = await browser.newContext({ reducedMotion });
    const page = await context.newPage();
    await mockUiApis(page, { auth: false });
    await page.goto("/?e2e=1");
    const header = page.getByRole("banner");
    await expect(header).toBeVisible();
    const animation = await header.evaluate((el) => {
      const a = el.getAnimations().find((x) => (x as CSSAnimation).animationName === "fade-in") as CSSAnimation | undefined;
      return { name: a?.animationName ?? null, duration: Number(a?.effect?.getComputedTiming().duration ?? 0) };
    });
    if (reducedMotion === "reduce") {
      // index.css shortens every animation to 0.01 ms under prefers-reduced-motion.
      expect(animation.duration).toBeLessThan(1);
    } else {
      expect(animation).toEqual({ name: "fade-in", duration: 800 });
    }
    await context.close();
  }
});

test("mesh: steps show a loading line, and device names stay on one line", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockUiApis(page);
  const releaseOnboarding = await holdRoute(page, "**/api/mesh/onboarding", ONBOARDING);
  await page.route("**/api/mesh/devices", (route) => json(route, DEVICES));
  await page.goto("/mesh");
  await expect(page.getByText("Loading the steps…")).toBeVisible();
  releaseOnboarding();
  await expect(page.getByText("Install Argo")).toBeVisible();
  await expect(page.getByText("Loading the steps…")).toHaveCount(0);
  const name = page.getByText("laptop-alpha", { exact: true });
  const lineHeight = await name.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  const box = await name.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(lineHeight + 1);
});

// ---- role-limited routes ----------------------------------------------------------------------

type Rule = { method: string; re: RegExp; access: string };
const RANK: Record<string, number> = { public: 0, user: 1, staff: 2, operator: 3, admin: 4 };
const POLICY: Rule[] = [
  ...readFileSync(join(process.cwd(), "backend/rbac.ts"), "utf8").matchAll(/\{ method: "(\w+)", path: "([^"]+)", access: "(\w+)" \}/g),
].map(([, method, path, access]) => ({ method, re: new RegExp(`^/api${path.replace(/:[^/]+/g, "[^/]+")}$`), access }));

const sessionFor = (role: string) => ({
  session: { id: "s1", userId: "u1", token: "mock", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  user: { id: "u1", email: "someone@gauss.space", name: "Someone", emailVerified: true, role },
});

for (const { role, pages } of [
  { role: null, pages: ["/"] },
  { role: "user", pages: ["/", "/heliophysics"] },
  { role: "staff", pages: ["/", "/mesh"] },
] as const) {
  test(`${role ?? "signed out"}: pages only call routes that role may use`, async ({ page }) => {
    expect(POLICY.length).toBeGreaterThan(20); // the parse found the policy
    await mockUiApis(page, { auth: false });
    await page.route("**/api/auth/get-session", (route) => json(route, role ? sessionFor(role) : null));
    const refused: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/auth/")) return;
      const rule = POLICY.find((r) => r.method === request.method() && r.re.test(url.pathname));
      if (rule && rule.access !== "public" && (!role || RANK[role] < RANK[rule.access])) refused.push(`${request.method()} ${url.pathname}`);
    });
    for (const path of pages) {
      await page.goto(`${path}${path.includes("?") ? "&" : "?"}e2e=1`);
      await expect(page.locator("main, h1").first()).toBeVisible();
      // Long enough for every page's first poll.
      await page.waitForTimeout(2_500);
    }
    expect(refused).toEqual([]);
  });
}
