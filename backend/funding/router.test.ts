import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AuthenticatedRequest, AuthRole } from "../auth.js";
import { enforceApiPolicy } from "../rbac.js";
import { FIXTURE_CELL_WORDS, SYNTHETIC_TRACKER_CSV } from "./fixtures/synthetic-tracker.js";
import { createFundingRouter, FUNDING_TRACKER_ENV, readTrackerFile, type FundingAnswer } from "./router.js";
import { MAX_TRACKER_BYTES } from "./tracker.js";

// Synthetic data only: the export these tests read is written here, into a temp dir, from
// backend/funding/fixtures/synthetic-tracker.ts. No test reads FUNDING_TRACKER_CSV from the machine.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NOW = Date.parse("2026-11-18T06:00:00Z"); // 18 Nov in every zone from UTC-6 to UTC+17
const dir = realpathSync(mkdtempSync(join(tmpdir(), "funding-view-")));
after(() => rmSync(dir, { recursive: true, force: true }));

function exportFile(name: string, text = SYNTHETIC_TRACKER_CSV): string {
  const file = join(dir, name);
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

type Call = (role: AuthRole | null, method?: string) => Promise<Response>;

/**
 * The router as the server mounts it: a session (here: the x-test-role header), then API_POLICY.
 * Every line written to the console or the router's log while it runs is returned in `lines`.
 */
async function withApi(path: string | undefined, fn: (call: Call) => Promise<void>, repoRoot = REPO_ROOT): Promise<string[]> {
  const lines: string[] = [];
  const keep = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  Object.assign(console, { log: keep, warn: keep, error: keep, info: keep });
  const app = express();
  app.use("/api", (req: AuthenticatedRequest, _res, next) => {
    const role = req.header("x-test-role") as AuthRole | undefined;
    if (role) req.auth = { userId: "u1", email: "t@example.org", role, rawRoles: [role], token: "t" };
    next();
  });
  app.use("/api", enforceApiPolicy);
  app.use("/api/admin/funding", createFundingRouter({ path: () => path, repoRoot, now: () => NOW }));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/funding`;
  try {
    await fn((role, method = "GET") => fetch(url, { method, headers: role ? { "x-test-role": role } : {} }));
  } finally {
    server.close();
    Object.assign(console, original);
  }
  return lines;
}

const answerOf = async (res: Response) => (await res.json()) as FundingAnswer;

test("funding view: admins only; no session 401, user, staff and operator 403, and there is no write route", async () => {
  await withApi(exportFile("roles.csv"), async (call) => {
    assert.equal((await call(null)).status, 401);
    for (const role of ["user", "staff", "operator"] as const) {
      const res = await call(role);
      assert.equal(res.status, 403, role);
      assert.ok(!(await res.text()).includes("Example"), `${role} gets nothing from the tracker`);
    }
    assert.equal((await call("admin")).status, 200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal((await call("admin", method)).status, 404, method);
  });
});

test("funding view: the summary of the export, its age from the file's mtime, and no-store", async () => {
  const file = exportFile("summary.csv");
  const exported = new Date("2026-11-18T03:20:00Z");
  utimesSync(file, exported, exported);
  await withApi(file, async (call) => {
    const res = await call("admin");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const a = await answerOf(res);
    assert.ok(a.configured && !("error" in a));
    assert.equal(a.exportedAt, "2026-11-18T03:20:00.000Z");
    assert.equal(a.today, "2026-11-18");
    assert.equal(a.readableByOthers, false);
    assert.equal(a.counts.total, 7);
    assert.deepEqual(a.counts.byType, { investor: 2, grant: 2, programme: 1, bid: 1, other: 1 });
    assert.deepEqual(a.upcoming.map((d) => [d.row, d.kind, d.days]), [[2, "nextAction", 5], [3, "deadline", 12], [6, "nextAction", 30]]);
    assert.deepEqual(a.overdue.map((d) => [d.row, d.kind, d.days]), [[9, "deadline", -10], [4, "nextAction", -3]]);
    assert.equal(a.ignoredColumns, 2);
    assert.deepEqual(a.problems.map((p) => p.row), [4, 7, 9, 9, 10]);
    assert.deepEqual(Object.keys(a).sort(), ["configured", "counts", "exportedAt", "ignoredColumns", "overdue", "problems", "readableByOthers", "rows", "today", "upcoming"]);
  });
  // An export other accounts on the machine can read is still shown, and flagged.
  chmodSync(file, 0o644);
  await withApi(file, async (call) => {
    const a = await answerOf(await call("admin"));
    assert.ok(a.configured && !("error" in a) && a.readableByOthers);
  });
});

test("funding view: without FUNDING_TRACKER_CSV the feature is off and answers configured false", async () => {
  for (const unset of [undefined, "", "   "]) {
    const lines = await withApi(unset, async (call) => {
      const res = await call("admin");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(await res.json(), { configured: false });
      assert.equal((await call("operator")).status, 403, "off is still admin-only");
    });
    assert.deepEqual(lines, []);
  }
  // The default reads the environment variable, which no test sets.
  assert.equal(FUNDING_TRACKER_ENV, "FUNDING_TRACKER_CSV");
  assert.equal(process.env[FUNDING_TRACKER_ENV], undefined, "tests must not run against a configured tracker");
});

test("funding view: a path inside the repository is refused, also through a symlink, and nothing is read", async () => {
  // A stand-in repository in the temp dir, so no tracker-like file is ever written into the real one.
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "data"), { recursive: true });
  const inside = join(repo, "data", "tracker.csv");
  writeFileSync(inside, SYNTHETIC_TRACKER_CSV, { mode: 0o600 });
  const link = join(dir, "link-to-inside.csv");
  symlinkSync(inside, link);
  for (const path of [inside, link]) {
    const lines = await withApi(path, async (call) => {
      const res = await call("admin");
      assert.equal(res.status, 200);
      const a = await answerOf(res);
      assert.ok(a.configured && "error" in a);
      assert.equal(a.error.code, "inside-repo");
      assert.deepEqual(Object.keys(a), ["configured", "error"]);
    }, repo);
    assert.deepEqual(lines, ["[funding] the tracker export can't be shown (inside-repo)"]);
  }
  // The real repository root is what the server uses: a file of this repository is refused.
  assert.deepEqual(readTrackerFile(join(REPO_ROOT, "package.json"), REPO_ROOT), { ok: false, code: "inside-repo" });
  assert.deepEqual(readTrackerFile("relative/tracker.csv", REPO_ROOT), { ok: false, code: "not-absolute" });
});

test("funding view: an oversized file is refused before it is parsed", async () => {
  const big = exportFile("big.csv", `Name\n${"Example row\n".repeat(Math.ceil(MAX_TRACKER_BYTES / 12) + 10)}`);
  await withApi(big, async (call) => {
    const a = await answerOf(await call("admin"));
    assert.ok(a.configured && "error" in a);
    assert.equal(a.error.code, "too-large");
  });
  // Exactly at the cap is read.
  const atCap = exportFile("at-cap.csv", `Name\n${"x".repeat(MAX_TRACKER_BYTES - 5)}`);
  const read = readTrackerFile(atCap, REPO_ROOT);
  assert.ok(read.ok && read.text.length === MAX_TRACKER_BYTES);
});

test("funding view: a file that disappears between reads gives an honest error, not a crash", async () => {
  const file = exportFile("vanishing.csv");
  const lines = await withApi(file, async (call) => {
    const first = await answerOf(await call("admin"));
    assert.ok(first.configured && !("error" in first) && first.counts.total === 7);
    rmSync(file);
    const res = await call("admin");
    assert.equal(res.status, 200);
    const gone = await answerOf(res);
    assert.ok(gone.configured && "error" in gone);
    assert.equal(gone.error.code, "missing");
    assert.deepEqual(Object.keys(gone), ["configured", "error"], "no rows from the earlier read are served");
    // Back again: read fresh, nothing was cached either way.
    exportFile("vanishing.csv", "Name\nExample row\n");
    const back = await answerOf(await call("admin"));
    assert.ok(back.configured && !("error" in back) && back.counts.total === 1);
  });
  assert.deepEqual(lines, ["[funding] the tracker export can't be shown (missing)"]);
});

test("funding view: a folder, a non-CSV file and an export without a Name column are refused by code", async () => {
  const cases: Array<[string, string]> = [
    [dir, "not-a-file"],
    [exportFile("page.csv", "<!doctype html><html><body>Sign in to continue</body></html>"), "not-csv"],
    [exportFile("nameless.csv", "Status,Deadline\nOpen,2026-11-30\n"), "no-name-column"],
  ];
  for (const [path, code] of cases) {
    await withApi(path, async (call) => {
      const a = await answerOf(await call("admin"));
      assert.ok(a.configured && "error" in a);
      assert.equal(a.error.code, code);
    });
  }
});

test("funding view: no cell text, header or path reaches a log line or an error message", async () => {
  const good = exportFile("quiet.csv");
  const nameless = exportFile("quiet-nameless.csv", SYNTHETIC_TRACKER_CSV.replace("\uFEFFName,", "Untitled,"));
  const missing = join(dir, "Example Ventures", "never-there.csv");
  const lines: string[] = [];
  const bodies: string[] = [];
  for (const path of [good, nameless, missing]) {
    lines.push(
      ...(await withApi(path, async (call) => {
        for (const role of [null, "user", "operator", "admin"] as const) {
          const res = await call(role);
          const text = await res.text();
          if (path !== good || role !== "admin") bodies.push(text);
        }
      })),
    );
  }
  assert.deepEqual(lines, ["[funding] the tracker export can't be shown (no-name-column)", "[funding] the tracker export can't be shown (missing)"]);
  for (const text of [...lines, ...bodies]) {
    for (const word of [...FIXTURE_CELL_WORDS, dir, "never-there", "quiet"]) assert.ok(!text.includes(word), `"${word}" leaked into: ${text.slice(0, 80)}`);
  }
});
