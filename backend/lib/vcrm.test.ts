import assert from "node:assert/strict";
import test from "node:test";
import { buildMatrix, parseJunit, renderMarkdown, validateBaseline, type Baseline } from "../../scripts/verify/vcrm.ts";

const junit = `<?xml version="1.0"?><testsuites>
  <testcase name="a passes" time="0.1" classname="test"/>
  <testcase name="b &quot;quoted&quot; &amp; fails" time="0.1" classname="test"><failure message="x">boom</failure></testcase>
  <testcase name="c is skipped" time="0" classname="test"><skipped/></testcase>
  <testcase name="d flaky" time="0.1" classname="test"/>
  <testcase name="d flaky" time="0.1" classname="test"><failure/></testcase>
</testsuites>`;

const base = (reqs: Partial<Baseline["requirements"][number]>[]): Baseline => ({
  version: "1",
  requirements: reqs.map((r, i) => ({
    id: `REQ-TST-00${i + 1}`, title: "t", statement: "It shall work.", rationale: "r", parent: "GAU-1", method: "T", owner: "o", ...r,
  })) as Baseline["requirements"],
});

test("VCRM: JUnit outcomes parsed, XML unescaped, worst outcome wins (GAU-120)", () => {
  const o = parseJunit(junit);
  assert.equal(o.get("a passes"), "pass");
  assert.equal(o.get('b "quoted" & fails'), "fail");
  assert.equal(o.get("c is skipped"), "skipped");
  assert.equal(o.get("d flaky"), "fail");
});

test("VCRM: verified only with all evidence passing; missing, failing or skipped tests are reported (GAU-120)", () => {
  const rows = buildMatrix(
    base([
      { verifiedBy: ["a passes"] },
      { verifiedBy: ["a passes", 'b "quoted" & fails'] },
      { verifiedBy: ["c is skipped"] },
      { verifiedBy: ["renamed test"] },
      { method: "I", verifiedBy: undefined, evidence: ["docs/x.md"] },
    ]),
    parseJunit(junit),
    (p) => p === "docs/x.md",
  );
  assert.deepEqual(rows.map((r) => r.status), ["verified", "failed", "unverified", "unverified", "verified"]);
  assert.match(rows[3].problems[0], /not found/);
  const md = renderMarkdown(rows, { version: "1", commit: "abc", generatedAt: "now" });
  assert.match(md, /2\/5 requirements verified/);
});

test("VCRM: baseline rules enforce id, 'shall', method and evidence (GAU-120)", () => {
  const problems = validateBaseline(base([
    { id: "bad", statement: "It works." },
    { method: "T", verifiedBy: [] },
    { method: "A", verifiedBy: undefined, evidence: [] },
  ]));
  assert.ok(problems.some((p) => p.includes("REQ-ABC-001")));
  assert.ok(problems.some((p) => p.includes('"shall"')));
  assert.ok(problems.some((p) => p.includes("needs verifiedBy")));
  assert.ok(problems.some((p) => p.includes("needs evidence")));
  assert.deepEqual(validateBaseline(base([{ verifiedBy: ["x"] }])), []);
});

test("FMEA: mitigated needs passing evidence; gaps are reported; broken evidence fails (GAU-121)", async () => {
  const { buildFmea, renderFmeaMarkdown } = await import("../../scripts/verify/vcrm.ts");
  const row = { item: "x", failureMode: "y", effect: "e", detection: "d", mitigation: "m", severity: 5, likelihood: 4, residualLikelihood: 1 };
  const res = buildFmea([
    { ...row, id: "FM-01", verifiedBy: ["a passes"] },
    { ...row, id: "FM-02", verifiedBy: [], gap: "standby host", residualLikelihood: 4 },
    { ...row, id: "FM-03", verifiedBy: ["renamed"] },
    { ...row, id: "FM-04", verifiedBy: [] },
    { ...row, id: "FM-05", verifiedBy: ["a passes"], severity: 7 },
  ], parseJunit(junit));
  assert.deepEqual(res.map((r) => r.status), ["mitigated", "gap", "broken", "broken", "broken"]);
  assert.equal(res[1].residualRisk, 20);
  assert.match(renderFmeaMarkdown(res), /20 \*\*HIGH\*\*/);
});

test("VCRM: an unescaped '>' in a test name does not swallow later test cases (GAU-127)", () => {
  const xml = `<testsuites>
    <testcase name="travel time L1 -> Earth follows the flow" time="0.1" classname="test" file="x"/>
    <testcase name=">2 MeV electrons alert" time="0.1" classname="test" file="x"/>
    <testcase name="after" time="0.1" classname="test" file="x"/>
    <testcase name="fails" time="0.1" classname="test" file="x"><failure message="a > b">x</failure></testcase>
  </testsuites>`;
  const o = parseJunit(xml);
  assert.equal(o.get("travel time L1 -> Earth follows the flow"), "pass");
  assert.equal(o.get(">2 MeV electrons alert"), "pass");
  assert.equal(o.get("after"), "pass");
  assert.equal(o.get("fails"), "fail");
  assert.equal(o.size, 4);
});
