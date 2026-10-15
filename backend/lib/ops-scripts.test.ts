import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The ops guard, alerts, watchdog and balance mode are tested in bash with stubbed system tools
// (no real power settings, processes or alerts). Run them here so `npm run verify` traces them.
test("ops resilience and balance tests (bash)", { timeout: 300_000 }, () => {
  const r = spawnSync("bash", ["scripts/ops/gauss-services.test.sh"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /gauss-services: \d+ passed, 0 failed/);
});
