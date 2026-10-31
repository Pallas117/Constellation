import assert from "node:assert/strict";
import test from "node:test";
import { layoutGarden, noteParts, resolveLink } from "./garden-layout";

test("layout is deterministic, inside the unit box, and counts link degree", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => ({ id, group: "member" }));
  const links = [
    { source: "a", target: "b" },
    { source: "a", target: "c" },
    { source: "a", target: "missing" },
    { source: "d", target: "d" },
  ];
  const one = layoutGarden(nodes, links);
  assert.deepEqual(one, layoutGarden(nodes, links));
  for (const p of one) assert.ok(p.x >= 0.03 && p.x <= 0.97 && p.y >= 0.03 && p.y <= 0.97, JSON.stringify(p));
  assert.deepEqual(one.map((p) => p.degree), [2, 1, 1, 0]);
  const dist = (i: number, j: number) => Math.hypot(one[i].x - one[j].x, one[i].y - one[j].y);
  assert.ok(dist(0, 1) < dist(1, 3), "linked notes sit closer than unlinked ones");
  assert.deepEqual(layoutGarden([], []), []);
});

test("note text splits into plain text and wikilinks (no HTML is ever produced)", () => {
  assert.deepEqual(noteParts("See [[Corpus/member/a|the guide]] and [[b#Setup]].<script>"), [
    { text: "See " },
    { link: "Corpus/member/a", label: "the guide" },
    { text: " and " },
    { link: "b", label: "b" },
    { text: ".<script>" },
  ]);
  assert.deepEqual(noteParts("plain"), [{ text: "plain" }]);
});

test("links resolve by path, then by a unique name", () => {
  const ids = ["Corpus/member/a", "Corpus/operator/b", "Corpus/member/b"];
  assert.equal(resolveLink("Corpus/member/a", ids), "Corpus/member/a");
  assert.equal(resolveLink("a", ids), "Corpus/member/a");
  assert.equal(resolveLink("b", ids), null, "ambiguous");
  assert.equal(resolveLink("hidden", ids), null);
});
