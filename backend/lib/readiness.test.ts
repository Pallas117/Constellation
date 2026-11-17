import assert from "node:assert/strict";
import test from "node:test";
import {
  computeReadiness,
  parsePolicy,
  renderReadinessMarkdown,
  routeRegex,
  summaryLine,
  testBody,
  type ReadinessInput,
} from "../../scripts/verify/readiness.ts";
import type { FmeaRow, Requirement } from "../../scripts/verify/vcrm.ts";

const req = (o: Partial<Requirement>): Requirement => ({
  id: "REQ-TST-001", title: "t", statement: "The system shall answer within 5 s.", rationale: "r", parent: "GAU-1", method: "T", owner: "o",
  verifiedBy: ["alpha works", "alpha fails safe"], ...o,
});

const input = (reqs: Requirement[], o: Partial<ReadinessInput> = {}): ReadinessInput => ({
  baseline: { version: "1", requirements: reqs },
  outcomes: new Map([["alpha works", "pass"], ["alpha fails safe", "pass"]]),
  fmea: [],
  policy: [],
  testFiles: [{ path: "backend/alpha.test.ts", text: `test("alpha works", () => {});\ntest("alpha fails safe", () => {});\n` }],
  docs: [{ path: "docs/ARCHITECTURE.md", text: "The alpha module lives in backend/alpha.test.ts." }],
  exists: () => true,
  ...o,
});

const fm = (o: Partial<FmeaRow>): FmeaRow => ({
  id: "FM-99", item: "i", failureMode: "f", effect: "e", detection: "d", mitigation: "m",
  severity: 3, likelihood: 3, residualLikelihood: 1, verifiedBy: ["alpha works"], ...o,
});

test("readiness: a fully evidenced internal requirement scores 100 and shows its reasons", () => {
  const r = computeReadiness(input([req({})])).requirements[0];
  assert.equal(r.score, 100);
  assert.equal(r.parts.endToEnd.reason, "internal");
  assert.equal(r.parts.verification.score, 30);
  assert.deepEqual(r.todo, []);
});

test("readiness: specification loses points for two shalls, no number and a missing parent", () => {
  const r = computeReadiness(input([req({ statement: "It shall work and shall be fast.", parent: "" })])).requirements[0];
  assert.equal(r.parts.specification.score, 0 + 0 + 0 + 0);
  assert.ok(r.parts.specification.todo.some((t) => /2 "shall"/.test(t)));
  assert.ok(r.parts.specification.todo.some((t) => /no number/.test(t)));
});

test("readiness: verification is 0 when a mapped test is skipped or missing, lower for a single test", () => {
  const skipped = computeReadiness(input([req({})], { outcomes: new Map([["alpha works", "pass"], ["alpha fails safe", "skipped"]]) })).requirements[0];
  assert.equal(skipped.parts.verification.score, 0);
  assert.ok(skipped.parts.verification.todo[0].includes("alpha fails safe"));
  const missing = computeReadiness(input([req({})], { outcomes: new Map() })).requirements[0];
  assert.equal(missing.parts.verification.score, 0);
  const single = computeReadiness(input([req({ verifiedBy: ["alpha works"] })])).requirements[0];
  assert.ok(single.parts.verification.score > 0 && single.parts.verification.score < 30);
});

test("readiness: non-T methods score on present evidence paths, 0 when one is missing", () => {
  const ok = computeReadiness(input([req({ method: "I", verifiedBy: undefined, evidence: ["docs/ARCHITECTURE.md"] })])).requirements[0];
  assert.equal(ok.parts.verification.score, 18);
  const gone = computeReadiness(input([req({ method: "I", verifiedBy: undefined, evidence: ["nope.md"] })], { exists: () => false })).requirements[0];
  assert.equal(gone.parts.verification.score, 0);
});

test("readiness: policy parsed from rbac.ts; route regexes match params and templates, not longer paths", () => {
  const policy = parsePolicy(`export const API_POLICY = [\n  { method: "GET", path: "/device/:id", access: "user" },\n  { method: "GET", path: "/device", access: "user" }, // x\n];`);
  assert.deepEqual(policy.map((p) => p.path), ["/device/:id", "/device"]);
  assert.ok(routeRegex("/device/:id").test("fetch(`/api/device/${id}`)"));
  assert.ok(routeRegex("/device").test('get("/api/device")'));
  assert.ok(!routeRegex("/device").test('get("/api/device/register")'));
});

test("readiness: route-backed requirement needs an end-to-end test and a 401/403 assertion", () => {
  const policy = parsePolicy(`{ method: "GET", path: "/feed/x", access: "user" }`);
  const reqs = [req({ verifiedBy: ["feed x serves"], statement: "GET /feed/x shall return a point within 5 s." })];
  const outcomes = new Map([["feed x serves", "pass" as const]]);
  const bare = computeReadiness(input(reqs, { policy, outcomes, testFiles: [{ path: "backend/feed.test.ts", text: `test("feed x serves", () => {});` }] })).requirements[0];
  assert.deepEqual(bare.routes, ["GET /feed/x"]);
  assert.equal(bare.parts.endToEnd.score, 0);
  assert.ok(bare.parts.endToEnd.todo[0].includes("/feed/x"));
  assert.equal(bare.parts.security.score, 5);
  const full = computeReadiness(input(reqs, {
    policy, outcomes,
    testFiles: [
      { path: "backend/feed.test.ts", text: `test("feed x serves", () => {});` },
      { path: "backend/server.access.test.ts", text: `test("denied", async () => { assert.equal((await get("/api/feed/x")).status, 401); });` },
    ],
  })).requirements[0];
  assert.equal(full.parts.endToEnd.score, 20);
  assert.equal(full.parts.security.score, 10);
});

test("readiness: FMEA gaps and high residual risk lower failure analysis; mitigated rows keep it full", () => {
  const reqs = [req({})];
  assert.equal(computeReadiness(input(reqs, { fmea: [fm({})] })).requirements[0].parts.failureAnalysis.score, 15);
  const gap = computeReadiness(input(reqs, { fmea: [fm({}), fm({ id: "FM-98", gap: "no soak test" })] })).requirements[0].parts.failureAnalysis;
  assert.equal(gap.score, 8);
  assert.ok(gap.todo[0].includes("FM-98"));
  const high = computeReadiness(input(reqs, { fmea: [fm({ severity: 5, residualLikelihood: 3 })] })).requirements[0].parts.failureAnalysis;
  assert.equal(high.score, 12);
});

test("readiness: documentation counts key paths mentioned in docs", () => {
  const none = computeReadiness(input([req({})], { docs: [{ path: "docs/X.md", text: "unrelated" }] })).requirements[0].parts.documentation;
  assert.equal(none.score, 0);
  assert.ok(none.todo[0].includes("backend/alpha.test.ts"));
});

test("readiness: issues roll up the mean; summary names requirements below 60; markdown shows to-dos", () => {
  const reqs = [req({}), req({ id: "REQ-TST-002", parent: "GAU-2", statement: "It shall work.", verifiedBy: ["nope"] }), req({ id: "REQ-TST-003", parent: "GAU-2", statement: "It shall work.", verifiedBy: ["nope"] })];
  const report = computeReadiness(input(reqs));
  assert.deepEqual(report.issues.map((i) => i.parent), ["GAU-2", "GAU-1"]);
  assert.equal(report.issues[1].score, 100);
  assert.deepEqual(report.below, ["REQ-TST-002", "REQ-TST-003"]);
  assert.equal(summaryLine(report), "readiness: median 56, 2 requirements below 60: REQ-TST-002, REQ-TST-003");
  assert.match(renderReadinessMarkdown(report, { version: "1", commit: "abc", generatedAt: "now" }), /## To-do[\s\S]*REQ-TST-002/);
});

test("readiness: testBody stops at the next top-level test", () => {
  const files = [{ path: "a.test.ts", text: `test("one", () => { x(401); });\ntest("two", () => { y(); });\n` }];
  assert.ok(testBody(files, "one").body.includes("401"));
  assert.ok(!testBody(files, "one").body.includes("y()"));
  assert.equal(testBody(files, "absent").file, undefined);
});
