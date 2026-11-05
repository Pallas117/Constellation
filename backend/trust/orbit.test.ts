import assert from "node:assert/strict";
import test from "node:test";
import { eciToGeodetic, gstime, propagate, twoline2satrec } from "satellite.js";
import { EnvironmentHistory } from "./environment.js";
import { distanceKm, MAX_TLE_AGE_DAYS, propagateTle, tleProblem } from "./orbit.js";
import { buildTrustRecord, parseTrustRequest } from "./record.js";

// ISS (ZARYA), the example TLE in the satellite.js README: epoch 2019 day 156.50900463 =
// 2019-06-05 12:12:58 UTC (0.50900463 d = 43,978 s), inclination 51.6433°.
const ISS: [string, string] = [
  "1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992",
  "2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442",
];
const EPOCH = Date.parse("2019-06-05T12:12:58.000Z");
const DAY = 86_400_000;

test("TLE: format, catalogue number and the modulo-10 checksum are checked; satellite.js checks none of them (GAU-57)", () => {
  assert.equal(tleProblem(ISS), null);
  const flipped = ISS[0].slice(0, 20) + "7" + ISS[0].slice(21); // one digit changed, checksum now wrong
  assert.equal(tleProblem([flipped, ISS[1]]), "line 1 checksum fails");
  assert.equal(tleProblem([ISS[0].slice(0, 60), ISS[1]]), "line 1 must be 69 characters");
  assert.equal(tleProblem([ISS[1], ISS[0]]), 'line 1 must start with "1 "');
  const other = ISS[1].replace("2 25544", "2 25545");
  const fixed = other.slice(0, 68) + String((Number(other[68]) + 1) % 10); // keep its checksum valid
  assert.equal(tleProblem([ISS[0], fixed]), "the two lines name different catalogue numbers");
  assert.equal(tleProblem(["only one line"]), "tle must be two lines");
});

test("TLE: SGP4 places the ISS at its known altitude and within its inclination (GAU-57)", () => {
  const at = propagateTle(ISS, EPOCH);
  assert.ok(!("error" in at), JSON.stringify(at));
  assert.ok(at.ephemeris.altKm > 395 && at.ephemeris.altKm < 425, `ISS altitude ${at.ephemeris.altKm.toFixed(1)} km`);
  assert.ok(Math.abs(at.ephemeris.latDeg) <= 51.7, "never above the orbit's inclination");
  assert.ok(Math.abs(at.ageDays) < 1e-4);
  // Our geocentric latitude against satellite.js's own geodetic one: within the ~0.2° ellipsoid difference.
  const date = new Date(EPOCH);
  const geo = eciToGeodetic(propagate(twoline2satrec(ISS[0], ISS[1]), date)!.position as { x: number; y: number; z: number }, gstime(date));
  assert.ok(Math.abs((geo.latitude * 180) / Math.PI - at.ephemeris.latDeg) < 0.25);
});

test("TLE: an epoch more than 7 days from the inference is not used (GAU-57)", () => {
  assert.ok(!("error" in propagateTle(ISS, EPOCH + MAX_TLE_AGE_DAYS * DAY - 60_000)));
  const stale = propagateTle(ISS, EPOCH + 10 * DAY);
  assert.ok("error" in stale);
  assert.equal(stale.error, "TLE epoch 2019-06-05 is 10.0 days from the inference (limit 7)");
  assert.ok("error" in propagateTle(ISS, EPOCH - 8 * DAY), "nor long before the epoch");
});

const empty = new EnvironmentHistory([], "test history");
const record = (over: Record<string, unknown>) => {
  const parsed = parseTrustRequest({ time: new Date(EPOCH + 3_600_000).toISOString(), spacecraftId: "ISS", modelId: "m", ...over });
  assert.ok("request" in parsed, JSON.stringify(parsed));
  return buildTrustRecord(parsed.request, empty, { nowMs: EPOCH + DAY });
};

test("trust record: a TLE alone gives the position and L-shell, with the epoch and its age (GAU-57)", () => {
  const r = record({ tle: ISS });
  assert.ok(r.orbit.position.value);
  assert.equal(r.orbit.position.source, "Propagated from the supplied TLE");
  assert.match(r.orbit.position.method, /^SGP4 \(satellite\.js\) from the TLE, epoch 2019-06-05T12:12Z, 0\.0 days before the inference$/);
  assert.equal(r.orbit.position.ageSeconds, 3600);
  assert.equal(r.orbit.position.confidence, "high");
  assert.ok(r.orbit.lShell.value! >= 1 && r.orbit.lShell.value! < 3, `LEO L-shell ${r.orbit.lShell.value}`);
  assert.equal(r.orbit.lShell.source, "Computed from the TLE-propagated position");
});

test("trust record: an ephemeris and a TLE that disagree are conflicting inputs, so both read unknown (GAU-57)", () => {
  const tle = propagateTle(ISS, EPOCH + 3_600_000);
  assert.ok(!("error" in tle));
  const near = { ...tle.ephemeris, altKm: tle.ephemeris.altKm + 5 };
  const agrees = record({ tle: ISS, ephemeris: near });
  assert.equal(agrees.orbit.position.source, "Supplied ephemeris");
  assert.match(agrees.orbit.position.method, /^as supplied; agrees with the TLE to 5\.\d km$/);
  const far = { latDeg: -tle.ephemeris.latDeg, lonDeg: tle.ephemeris.lonDeg + 90, altKm: tle.ephemeris.altKm };
  assert.ok(distanceKm(far, tle.ephemeris) > 1000);
  const conflict = record({ tle: ISS, ephemeris: far });
  assert.equal(conflict.orbit.position.value, null);
  assert.equal(conflict.orbit.lShell.value, null);
  assert.match(conflict.orbit.lShell.limitations[0], /^Conflicting inputs: the ephemeris and the TLE place the spacecraft \d+ km apart \(limit 100 km\)$/);
});

test("trust record: a malformed TLE is refused at the door with its reason (GAU-57)", () => {
  const flipped = ISS[0].slice(0, 20) + "7" + ISS[0].slice(21);
  assert.deepEqual(parseTrustRequest({ time: "2019-06-05T13:13:00Z", spacecraftId: "ISS", modelId: "m", tle: [flipped, ISS[1]] }), {
    errors: ["tle: line 1 checksum fails"],
  });
});
