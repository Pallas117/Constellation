import assert from "node:assert/strict";
import test from "node:test";
import { getCanonicalFeed, getLatestCanonical, seedCanonical } from "./state.js";
import type { CanonicalSpaceWeatherPoint } from "./types.js";

// Own file: the feed is module state and seeding only fills an empty buffer.
test("seeded points share one NOAA alert list while it is unchanged (20,000 copies before)", () => {
  const alerts = (headline: string) => [{ headline }] as unknown as CanonicalSpaceWeatherPoint["noaaAlerts"];
  // As parsed from bedrock: every line has its own, equal array.
  const pts = [alerts("G1"), alerts("G1"), alerts("G1"), alerts("G2"), alerts("G2"), null].map(
    (noaaAlerts, i) => ({ timestamp: new Date(Date.UTC(2026, 9, 29, 0, 0, i)).toISOString(), noaaAlerts }) as CanonicalSpaceWeatherPoint,
  );
  assert.equal(seedCanonical(pts), 6);
  const feed = getCanonicalFeed();
  assert.equal(feed[0].noaaAlerts, feed[1].noaaAlerts);
  assert.equal(feed[1].noaaAlerts, feed[2].noaaAlerts);
  assert.notEqual(feed[2].noaaAlerts, feed[3].noaaAlerts, "a new list starts a new shared array");
  assert.equal(feed[3].noaaAlerts, feed[4].noaaAlerts);
  assert.deepEqual(feed.map((p) => (p.noaaAlerts ?? null) && p.noaaAlerts?.[0]), [
    { headline: "G1" }, { headline: "G1" }, { headline: "G1" }, { headline: "G2" }, { headline: "G2" }, null,
  ], "content unchanged");
  assert.equal(getLatestCanonical(), feed[5]);
});
