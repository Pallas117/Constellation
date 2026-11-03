import assert from "node:assert/strict";
import test from "node:test";
import { extendPattern, noticeText, patternProblem, PATTERN_RULES, samePattern, vertexAt } from "./pattern";
import { project, randomRotation, VERTICES } from "./tesseract";

test("the pattern pad takes 8 to 24 vertices, 6 or more different, no vertex twice in a row", () => {
  assert.equal(patternProblem([0, 5, 10, 15, 3, 6, 9, 12]), null);
  assert.match(patternProblem([0, 1, 2]) ?? "", /draw 8 to 24 vertices \(this one has 3\)/);
  assert.match(patternProblem([0, 1, 0, 1, 0, 1, 0, 1]) ?? "", /at least 6 different/);
  assert.match(patternProblem([0, 0, 1, 2, 3, 4, 5, 6]) ?? "", /twice in a row/);
  assert.match(patternProblem([0, 1, 2, 3, 4, 5, 6, 16]) ?? "", /A to P/);
  // Drawing never adds the same vertex twice in a row or past the maximum.
  assert.deepEqual(extendPattern([3], 3), [3]);
  assert.deepEqual(extendPattern([3], 4), [3, 4]);
  assert.equal(extendPattern(Array.from({ length: PATTERN_RULES.maxLength }, (_, i) => i % 2), 7).length, PATTERN_RULES.maxLength);
  assert.ok(samePattern([1, 2, 3], [1, 2, 3]) && !samePattern([1, 2, 3], [1, 2]) && !samePattern([1, 2, 3], [1, 3, 2]));
});

test("a touch picks the nearest vertex within reach, whatever the figure's orientation", () => {
  for (let k = 0; k < 200; k++) {
    const points = VERTICES.map((v) => project(v, randomRotation(), 400));
    const target = k % 16;
    assert.equal(vertexAt(points, points[target].x + 3, points[target].y - 2, 24) >= 0, true);
    assert.equal(vertexAt(points, -100, -100, 24), -1);
  }
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  assert.equal(vertexAt(points, 7, 0, 24), 1, "nearest wins");
});

test("the pattern page says what the sensor saw since the last sign-in, and nothing when it saw nothing", () => {
  const at = (ms: number) => `t${ms}`;
  assert.equal(noticeText({ misses: 0, probes: 0, unusual: 0, lastIp: null, lastAt: null }, at), null);
  assert.equal(noticeText(undefined, at), null);
  assert.equal(
    noticeText({ misses: 2, probes: 1, unusual: 0, lastIp: "100.64.0.9", lastAt: 5 }, at),
    "Since your last sign-in: 2 wrong drawings; 1 unknown phone code tried, last at t5 from 100.64.0.9. Not you? Tell an admin.",
  );
  assert.match(noticeText({ misses: 0, probes: 0, unusual: 1, lastIp: null, lastAt: null }, at) ?? "", /read data unlike the console/);
});
