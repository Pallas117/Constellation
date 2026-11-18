import assert from "node:assert/strict";
import test from "node:test";
import { AIRGAP_AFTER, nextLinkState, pingCommand, type LinkState } from "./link-mode.js";

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

// 18 Nov 2026: "-W 2000" meant 2000 s on Linux and stalled every gate run on Talos for 33 min.
test("the ping waits 2 s on every platform: -W is ms on macOS, seconds on Linux", () => {
  assert.equal(pingCommand("8.8.8.8", "darwin"), "ping -c 1 -W 2000 8.8.8.8");
  assert.equal(pingCommand("8.8.8.8", "freebsd"), "ping -c 1 -W 2000 8.8.8.8");
  assert.equal(pingCommand("8.8.8.8", "linux"), "ping -c 1 -W 2 8.8.8.8");
});
