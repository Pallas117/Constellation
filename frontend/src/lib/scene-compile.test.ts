import assert from "node:assert/strict";
import { test } from "node:test";
import { compileQuietly } from "./scene-compile";

const program = (readyAfter: number) => {
  let polls = 0;
  return { isReady: () => ++polls > readyAfter };
};

test("waits until every live program is ready", async () => {
  const programs = [program(0), program(3)];
  let compiled = 0;
  await compileQuietly({ compile: () => compiled++, info: { programs } }, "scene", "camera", () => false, 5_000, 1);
  assert.equal(compiled, 1);
  assert.equal(programs.every((p) => p.isReady()), true);
});

// three's compileAsync threw "reading 'isReady'" here and never settled: the scene sat on
// "Preparing the field model…" until the 20 s fallback (GPU walk, 18 Nov 2026).
test("a program torn down mid-poll doesn't throw or stall", async () => {
  const gone = { isReady: () => { throw new TypeError("Cannot read properties of undefined (reading 'isReady')"); } };
  const start = performance.now();
  await compileQuietly({ compile: () => undefined, info: { programs: [gone, program(2)] } }, null, null, () => false, 5_000, 1);
  assert.ok(performance.now() - start < 1_000);
});

test("stops when cancelled and when the time limit passes", async () => {
  const never = { isReady: () => false };
  let cancel = false;
  setTimeout(() => (cancel = true), 20);
  await compileQuietly({ compile: () => undefined, info: { programs: [never] } }, null, null, () => cancel, 5_000, 1);
  const start = performance.now();
  await compileQuietly({ compile: () => undefined, info: { programs: [never] } }, null, null, () => false, 30, 1);
  assert.ok(performance.now() - start < 1_000);
});

test("no programs (null list) resolves at once", async () => {
  await compileQuietly({ compile: () => undefined, info: { programs: null } }, null, null, () => false, 5_000, 1);
});
