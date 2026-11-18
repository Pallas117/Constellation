import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { mockUiApis } from "./helpers/mockUiApis";

// GAU-59: the operator console's Evidence view shows the pilot flow a buyer sees: a log becomes
// trust records, then an evidence pack (JSON + PDF), then the check `npm run trust:verify` runs.
// Hermetic: the answers below are what the real routes gave for the synthetic sample log
// (tests/e2e/fixtures/evidence-analysis.json, written by scripts/trust/e2e-fixture.ts; not customer data).
interface Fixture {
  options: { sample: { name: string; text: string }; signOnHost: string; keys: Array<{ keyId: string }> };
  analysis: { pack: { packId: string; packHash: string; records: unknown[] }; records: unknown[]; summary: { rejected: unknown[] } };
  verify: { unsigned: { lines: string[] }; integrity: { lines: string[] } };
}
const fixture = JSON.parse(readFileSync(join(process.cwd(), "tests/e2e/fixtures/evidence-analysis.json"), "utf8")) as Fixture;
const PDF = Buffer.from("%PDF-1.4\n% mocked evidence pack PDF\n");
const shots = process.env.PW_SHOTS; // a directory: also save screenshots there (PR evidence)
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};

type Seen = { path: string; body: Record<string, unknown> | null };

/** The four evidence routes, answering as the backend does; every call is recorded. */
async function mockEvidence(page: Page): Promise<Seen[]> {
  const seen: Seen[] = [];
  await page.route("**/api/trust/evidence/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/trust/evidence", "");
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    seen.push({ path, body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/options") return json(fixture.options);
    if (path === "/analyse") return json(fixture.analysis);
    if (path === "/verify") return json(body?.allowUnsigned ? fixture.verify.integrity : fixture.verify.unsigned);
    if (path === "/pdf") return route.fulfill({ status: 200, contentType: "application/pdf", body: PDF });
    return json({ error: "Not found" }, 404);
  });
  return seen;
}

const session = (role: string) => {
  const user = { id: "user-0001", email: "someone@gauss.space", name: "Someone", emailVerified: true, role };
  return { session: { id: "sess-0001", userId: user.id, token: "mock", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, user };
};

async function build(page: Page) {
  await page.goto("/operator/evidence?e2e=1");
  await expect(page.getByRole("heading", { level: 1, name: "Evidence for a customer log." })).toBeVisible();
  await page.getByRole("button", { name: "Use the synthetic sample" }).click();
  await expect(page.getByTestId("evidence-log-state")).toContainText("synthetic, not customer data");
  await page.getByRole("button", { name: "Build trust records" }).click();
  await expect(page.getByRole("heading", { name: "One record for every accepted row." })).toBeVisible();
}

test.describe("Evidence view", () => {
  test("a log becomes trust records and a pack that downloads as JSON and PDF (GAU-59)", async ({ page }) => {
    await mockUiApis(page);
    const seen = await mockEvidence(page);
    await page.goto("/operator/evidence?e2e=1");
    await expect(page.getByText("No log loaded.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Build trust records" })).toBeDisabled();
    await build(page);

    const sent = seen.find((s) => s.path === "/analyse")?.body;
    expect(sent).toMatchObject({ log: fixture.options.sample.text, mappingId: "generic-csv", eventId: "jan-2026" });

    const records = page.getByRole("table", { name: "Trust records" }).locator("tbody tr");
    await expect(records).toHaveCount(fixture.analysis.records.length);
    await expect(records.first()).toContainText("DEMO-SAT-1");
    await expect(page.getByText("Rows not used, with the reason")).toBeVisible();
    await expect(page.getByText(/^row 9 · /)).toBeVisible();

    // The pack: its hash, that it is not signed, and that signing happens on the host, not here.
    await expect(page.getByText(fixture.analysis.pack.packHash)).toBeVisible();
    await expect(page.getByText("Not signed", { exact: true })).toBeVisible();
    await expect(page.getByText(fixture.options.signOnHost)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign/i })).toHaveCount(0);
    await shot(page, "evidence-desktop-pack");

    const [json] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download pack.json" }).click()]);
    expect(json.suggestedFilename()).toBe(`${fixture.analysis.pack.packId}.json`);
    // Byte for byte what `trust:ingest --pack` writes.
    expect(readFileSync(await json.path(), "utf8")).toBe(JSON.stringify(fixture.analysis.pack, null, 2) + "\n");

    const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download pack.pdf" }).click()]);
    expect(pdf.suggestedFilename()).toBe(`${fixture.analysis.pack.packId}.pdf`);
    expect(readFileSync(await pdf.path()).equals(PDF)).toBe(true);
    expect(seen.find((s) => s.path === "/pdf")?.body).toMatchObject({ pack: { packHash: fixture.analysis.pack.packHash } });
  });

  test("verification shows the trust:verify wording: FAILED unsigned, OK for integrity only (GAU-59)", async ({ page }) => {
    await mockUiApis(page);
    const seen = await mockEvidence(page);
    await build(page);
    const result = page.getByRole("status", { name: "Verification result" });

    await page.getByRole("button", { name: "Verify pack" }).click();
    await expect(result).toContainText("FAILED");
    await expect(result).toContainText(fixture.verify.unsigned.lines[1].trim());
    await shot(page, "evidence-desktop-verify-failed");

    await page.getByRole("checkbox", { name: /Integrity only/ }).check();
    await expect(result).toHaveCount(0); // an answer to another question is not left on screen
    await page.getByRole("button", { name: "Verify pack" }).click();
    await expect(result).toContainText(fixture.verify.integrity.lines[0]);
    await expect(result).toContainText("NOTE: NOT SIGNED: integrity only.");
    await shot(page, "evidence-desktop-verify-ok");

    const checks = seen.filter((s) => s.path === "/verify").map((s) => [s.body?.allowUnsigned, (s.body?.pack as { packHash: string }).packHash]);
    expect(checks).toEqual([
      [false, fixture.analysis.pack.packHash],
      [true, fixture.analysis.pack.packHash],
    ]);
  });

  test("a refused analysis shows the reason and no pack (GAU-59)", async ({ page }) => {
    await mockUiApis(page);
    await mockEvidence(page);
    await page.route("**/api/trust/evidence/analyse", (route) =>
      route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "The mapping can't be used: columns.time is missing" }) }),
    );
    await page.goto("/operator/evidence?e2e=1");
    await page.getByRole("button", { name: "Use the synthetic sample" }).click();
    await page.getByRole("button", { name: "Build trust records" }).click();
    await expect(page.getByRole("alert")).toContainText("The mapping can't be used: columns.time is missing");
    await expect(page.getByRole("button", { name: "Download pack.json" })).toHaveCount(0);
  });

  test("an account below operator is sent away and never calls the evidence API (GAU-59)", async ({ page }) => {
    await mockUiApis(page);
    const seen = await mockEvidence(page);
    for (const pattern of ["**/get-session", "**/api/auth/get-session"]) {
      await page.route(pattern, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session("staff")) }));
    }
    await page.goto("/operator/evidence?e2e=1");
    await expect(page).toHaveURL(/\/(\?.*)?$/);
    await expect(page.getByRole("heading", { name: "Evidence for a customer log." })).toHaveCount(0);
    expect(seen).toEqual([]); // CyberTiger counts 403s: the page must not even ask
  });

  test("the operator console links to it, and it fits a phone (GAU-59)", async ({ page }) => {
    await mockUiApis(page);
    await mockEvidence(page);
    await page.goto("/operator?e2e=1");
    await page.getByRole("navigation", { name: "Console" }).getByRole("link", { name: "Evidence" }).click();
    await expect(page).toHaveURL(/\/operator\/evidence/);

    await page.setViewportSize({ width: 375, height: 812 });
    await build(page);
    await page.getByRole("checkbox", { name: /Integrity only/ }).check();
    await page.getByRole("button", { name: "Verify pack" }).click();
    await expect(page.getByRole("status", { name: "Verification result" })).toContainText("OK");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shot(page, "evidence-phone");
  });
});
