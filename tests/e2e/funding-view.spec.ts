import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

// The admin-only funding tracker view (/operator/funding, GET /api/admin/funding).
// Hermetic and SYNTHETIC: every organisation, person, amount and status below is invented, in the
// shape backend/funding/router.ts answers with. No real tracker is read by this spec.
const shots = process.env.PW_SHOTS; // a directory: also save screenshots there (PR evidence)
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};

const row = (n: number, over: Record<string, unknown>) => ({
  row: n,
  name: `Example row ${n}`,
  type: "other",
  organisation: null,
  stage: null,
  amount: null,
  deadline: null,
  nextAction: null,
  nextActionDate: null,
  owner: null,
  link: null,
  lastContact: null,
  closed: false,
  ...over,
});

const tracker = (exportedAt: string) => ({
  configured: true,
  exportedAt,
  today: "2026-11-18",
  readableByOthers: false,
  rows: [
    row(2, { name: "Example Ventures seed", type: "investor", organisation: "Example Ventures", stage: "Intro call", amount: "EUR 250k", deadline: "rolling", nextAction: "Send the deck", nextActionDate: "2026-11-23", owner: "Owner A", link: "https://example.org/ventures", lastContact: "2026-11-01" }),
    row(3, { name: "Sample Space Agency call", type: "grant", organisation: "Sample Space Agency", stage: "Drafting", amount: "£50 000", deadline: "2026-11-30", owner: "Owner B", link: "https://example.org/call", lastContact: "2026-11-10" }),
    row(4, { name: "Placeholder Accelerator", type: "programme", organisation: "Placeholder Labs", stage: "Drafting", nextAction: "Book the interview", nextActionDate: "2026-11-15", owner: "Owner A", link: "javascript:alert(1)" }),
    row(5, { name: "Demo Constellation tender", type: "bid", organisation: "Demo Operator Ltd", stage: "Closed - lost", amount: "USD 1.2m", deadline: "2026-11-10", owner: "Owner C", closed: true }),
    row(9, { name: "Mystery Prize with a long name that has to wrap on a phone without pushing the page sideways", stage: "Intro call", deadline: "2026-11-08", nextAction: "Decide", nextActionDate: "2026-12-19" }),
  ],
  counts: {
    total: 5,
    byType: { investor: 1, grant: 1, programme: 1, bid: 1, other: 1 },
    byStage: [
      { stage: "Drafting", count: 2 },
      { stage: "Intro call", count: 2 },
      { stage: "Closed - lost", count: 1 },
    ],
  },
  upcoming: [
    { row: 2, kind: "nextAction", date: "2026-11-23", days: 5 },
    { row: 3, kind: "deadline", date: "2026-11-30", days: 12 },
  ],
  overdue: [
    { row: 9, kind: "deadline", date: "2026-11-08", days: -10 },
    { row: 4, kind: "nextAction", date: "2026-11-15", days: -3 },
  ],
  problems: [
    { row: 4, field: "deadline", reason: "slashed or dotted date is ambiguous (day/month or month/day): write it as 2026-11-01 or 1 Nov 2026" },
    { row: 7, field: "name", reason: "no name: row left out" },
  ],
  ignoredColumns: 2,
});

const session = (role: string) => {
  const user = { id: "user-0001", email: "someone@gauss.space", name: "Someone", emailVerified: true, role };
  return { session: { id: "sess-0001", userId: user.id, token: "mock", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, user };
};

/** mockUiApis signs in an operator; this signs in `role` instead. */
async function signInAs(page: Page, role: string) {
  for (const pattern of ["**/get-session", "**/api/auth/get-session"]) {
    await page.route(pattern, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session(role)) }));
  }
}

/** The one funding route, answering `answer`; every call is recorded with its method. */
async function mockFunding(page: Page, answer: unknown): Promise<string[]> {
  const seen: string[] = [];
  await page.route("**/api/admin/funding**", async (route) => {
    seen.push(route.request().method());
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(answer) });
  });
  return seen;
}

const HEADING = "Where every investor conversation, application and bid stands.";
const recently = () => new Date(Date.now() - 2 * 3_600_000).toISOString();

test.describe("Funding tracker view (admin only)", () => {
  test("an admin sees the copy: counts, due and overdue first, the pipeline by stage, and its age", async ({ page }) => {
    await mockUiApis(page);
    await signInAs(page, "admin");
    const seen = await mockFunding(page, tracker(recently()));
    await page.goto("/operator/funding?e2e=1");
    await expect(page.getByRole("heading", { level: 1, name: HEADING })).toBeVisible();

    // Data age is always on screen, with the reminder of what this is.
    const age = page.getByTestId("funding-data-age");
    await expect(age).toContainText(/Exported \d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}/);
    await expect(age).toContainText("this is a copy, the Sheet is the source of truth");
    await expect(age).toContainText("Copy");

    const counts = page.getByRole("region", { name: "Counts" });
    for (const [label, n] of [["In the tracker", "5"], ["Investors", "1"], ["Grants", "1"], ["Programmes", "1"], ["Bids", "1"], ["Due in 30 days", "2"], ["Overdue", "2"]]) {
      await expect(counts.locator("div", { hasText: label }).last()).toContainText(n);
    }

    // Due and overdue come before the pipeline, each with words for the state, not colour alone.
    const due = page.getByRole("list", { name: "Due in the next 30 days" }).getByRole("listitem");
    await expect(due).toHaveCount(2);
    await expect(due.first()).toContainText("Example Ventures seed");
    await expect(due.first()).toContainText("Next action: Send the deck");
    await expect(due.first()).toContainText("23 Nov 2026");
    await expect(due.first()).toContainText("in 5 days");
    await expect(due.nth(1)).toContainText("Deadline");
    const overdue = page.getByRole("list", { name: "Overdue", exact: true }).getByRole("listitem");
    await expect(overdue).toHaveCount(2);
    await expect(overdue.first()).toContainText("Overdue");
    await expect(overdue.first()).toContainText("10 days late");
    const order = await page.getByRole("heading", { level: 2 }).allTextContents();
    expect(order).toEqual(["Due in the next 30 days.", "Overdue and not closed.", "The pipeline, by stage.", "What the copy could not read."]);

    // The pipeline: grouped by stage, the type as a word, missing values as a dash.
    const drafting = page.getByRole("list", { name: "Stage: Drafting" }).getByRole("listitem");
    await expect(drafting).toHaveCount(2);
    await expect(drafting.first()).toContainText("Sample Space Agency call");
    await expect(drafting.first()).toContainText("Grant");
    await expect(drafting.first()).toContainText("£50 000");
    await expect(drafting.first().getByRole("link", { name: "example.org" })).toHaveAttribute("rel", "noopener noreferrer");
    await expect(drafting.nth(1)).toContainText("Programme");
    await expect(drafting.nth(1)).toContainText("—");
    await expect(drafting.nth(1).getByRole("link")).toHaveCount(0); // a link that is not http(s) is never rendered as one
    await expect(page.getByRole("list", { name: "Stage: Closed - lost" }).getByRole("listitem")).toHaveCount(1);

    // Problems by sheet row, and the ignored columns as a count only.
    const problems = page.getByRole("list", { name: "Problems in the export" });
    await expect(problems).toContainText("Sheet row 4 · Deadline · slashed or dotted date is ambiguous");
    await expect(page.getByText("2 columns in the export are not shown here.")).toBeVisible();

    // Read-only: nothing to type into or submit. One read on opening, one more per Reload, GET only.
    await expect(page.locator("main").locator("input, textarea, select, form, [contenteditable]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /edit|save|delete|add|upload/i })).toHaveCount(0);
    expect(seen).toEqual(["GET"]);
    await shot(page, "funding-desktop");
    await page.getByRole("button", { name: "Reload" }).click();
    await expect.poll(() => seen).toEqual(["GET", "GET"]);
    await page.waitForTimeout(1500);
    expect(seen).toEqual(["GET", "GET"]); // no polling
  });

  test("an old export is labelled stale, and a file other accounts can read is flagged", async ({ page }) => {
    await mockUiApis(page);
    await signInAs(page, "admin");
    await mockFunding(page, { ...tracker("2026-01-05T04:00:00.000Z"), readableByOthers: true });
    await page.goto("/operator/funding?e2e=1");
    await expect(page.getByTestId("funding-data-age")).toContainText("Stale copy");
    await expect(page.getByTestId("funding-data-age")).toContainText(/\d+ days ago/);
    await expect(page.getByText("Other accounts on this machine can read the export file")).toBeVisible();
  });

  test("an operator is sent away, the page never calls the funding API, and the console shows no link to it", async ({ page }) => {
    await mockUiApis(page); // signs in an operator
    const seen = await mockFunding(page, tracker(recently()));
    await page.goto("/operator/funding?e2e=1");
    await expect(page).toHaveURL(/\/(\?.*)?$/);
    await expect(page.getByRole("heading", { name: HEADING })).toHaveCount(0);

    await page.goto("/operator?e2e=1");
    const nav = page.getByRole("navigation", { name: "Console" });
    await expect(nav.getByRole("link", { name: "Evidence" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Funding" })).toHaveCount(0);
    expect(seen).toEqual([]); // CyberTiger counts 403s: the page must not even ask
  });

  test("an admin has the link in the console, and it opens the view", async ({ page }) => {
    await mockUiApis(page);
    await signInAs(page, "admin");
    const seen = await mockFunding(page, tracker(recently()));
    await page.goto("/operator?e2e=1");
    const link = page.getByRole("navigation", { name: "Console" }).getByRole("link", { name: "Funding" });
    await expect(link).toBeVisible();
    expect(seen).toEqual([]); // the console itself does not read the tracker
    await link.click();
    await expect(page.getByRole("heading", { level: 1, name: HEADING })).toBeVisible();
    await expect.poll(() => seen).toEqual(["GET"]);
  });

  test("switched off: the page says how to switch it on and shows no data", async ({ page }) => {
    await mockUiApis(page);
    await signInAs(page, "admin");
    const seen = await mockFunding(page, { configured: false });
    await page.goto("/operator/funding?e2e=1");
    await expect(page.getByRole("heading", { name: "The tracker view is switched off on this server." })).toBeVisible();
    await expect(page.getByText("FUNDING_TRACKER_CSV")).toBeVisible();
    await expect(page.getByText(/outside the repository/)).toBeVisible();
    await expect(page.getByTestId("funding-data-age")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Counts" })).toHaveCount(0);
    expect(seen).toEqual(["GET"]);
    await shot(page, "funding-desktop-switched-off");
  });

  test("an export that can't be read shows the reason and no data; a malformed answer shows nothing as data", async ({ page }) => {
    await mockUiApis(page);
    await signInAs(page, "admin");
    await mockFunding(page, { configured: true, error: { code: "missing", message: "The export is not where the setting says it is: export the sheet again, or correct the path." } });
    await page.goto("/operator/funding?e2e=1");
    await expect(page.getByRole("alert")).toContainText("Export not shown");
    await expect(page.getByRole("alert")).toContainText("The export is not where the setting says it is");
    await expect(page.getByRole("region", { name: "Counts" })).toHaveCount(0);

    await page.unroute("**/api/admin/funding**");
    await mockFunding(page, { configured: true, rows: "not a list" });
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByRole("alert")).toContainText("Unavailable");
    await expect(page.getByRole("region", { name: "Counts" })).toHaveCount(0);
  });

  test("phone width: cards, not a table, and no sideways overflow", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockUiApis(page);
    await signInAs(page, "admin");
    await mockFunding(page, tracker(recently()));
    await page.goto("/operator/funding?e2e=1");
    await expect(page.getByRole("heading", { level: 1, name: HEADING })).toBeVisible();
    await expect(page.getByRole("list", { name: "Stage: Intro call" }).getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("table")).toHaveCount(0);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.client);
    // Every card stays inside the screen.
    for (const box of await page.locator("main li").evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right })))) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(375);
    }
    await shot(page, "funding-phone-375");
  });
});
