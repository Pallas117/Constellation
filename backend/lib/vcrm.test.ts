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
