import assert from "node:assert/strict";
import test from "node:test";
import { parseSwarmRow } from "./esa-hapi.js";

test("Swarm rows: position plus B_NEC; any missing value rejects the row (GAU-85)", () => {
  assert.deepEqual(parseSwarmRow(["2026-10-12T03:57:00.000Z", 84.1, 85.7, 6781642.41, [1000, -200, 39000]]), {
    timestamp: "2026-10-12T03:57:00.000Z", latitudeDeg: 84.1, longitudeDeg: 85.7, radiusKm: 6781.64241, n: 1000, e: -200, c: 39000,
  });
  assert.equal(parseSwarmRow(["2026-10-12T03:57:17.000Z", 84.1, 85.7, 6781642.41, [null, null, null]]), null, "NaN-filled tail");
  assert.equal(parseSwarmRow(["2026-10-12T03:57:17.000Z", null, 85.7, 6781642.41, [1, 2, 3]]), null, "no latitude");
  assert.equal(parseSwarmRow(["2026-10-12T03:57:17.000Z", 95, 85.7, 6781642.41, [1, 2, 3]]), null, "impossible latitude");
  assert.equal(parseSwarmRow(["2026-10-12T03:57:17.000Z", 10, 85.7, 6781.6, [1, 2, 3]]), null, "radius in km, not m");
  assert.equal(parseSwarmRow(["2026-10-12T03:57:17.000Z", [1, 2, 3]]), null, "old B_NEC-only layout");
});
