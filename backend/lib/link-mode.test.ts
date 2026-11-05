import assert from "node:assert/strict";
import test from "node:test";
import { AIRGAP_AFTER, nextLinkState, type LinkState } from "./link-mode.js";

const cloud: LinkState = { mode: "CLOUD", latencyMs: 40, failures: 0 };

test("one lost ping keeps the last mode: fetches don't stop for a blip", () => {
  const s = nextLinkState(cloud, null);
  assert.equal(s.mode, "CLOUD");
  assert.equal(s.latencyMs, 40);
  assert.equal(s.failures, 1);
});

test(`${AIRGAP_AFTER} lost pings in a row switch to AIRGAP`, () => {
  let s = cloud;
  for (let i = 0; i < AIRGAP_AFTER; i++) s = nextLinkState(s, null);
  assert.deepEqual(s, { mode: "AIRGAP", latencyMs: -1, failures: AIRGAP_AFTER });
});

test("a ping that answers resets the count and picks CLOUD or SAT by latency", () => {
  const down = nextLinkState(nextLinkState(cloud, null), null);
  assert.deepEqual(nextLinkState(down, 60), { mode: "CLOUD", latencyMs: 60, failures: 0 });
  assert.equal(nextLinkState(down, 600).mode, "SAT");
  assert.equal(nextLinkState(nextLinkState(cloud, null), 30).failures, 0);
});
