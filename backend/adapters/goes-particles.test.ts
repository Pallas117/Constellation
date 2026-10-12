import assert from "node:assert/strict";
import test from "node:test";
import {
  ELECTRON_CHANNEL,
  PARTICLE_MAX_AGE_MS,
  PROTON_CHANNEL,
  fetchGoesParticles,
  freshReading,
  getGoesStatus,
  pickChannel,
} from "./goes-particles.js";

const now = Date.parse("2026-10-12T04:10:00Z");
const protons = [
  { time_tag: "2026-10-12T04:00:00Z", satellite: 18, flux: 0.31, energy: ">=1 MeV" },
  { time_tag: "2026-10-12T03:55:00Z", satellite: 18, flux: 0.24, energy: PROTON_CHANNEL },
  { time_tag: "2026-10-12T04:00:00Z", satellite: 18, flux: 0.25, energy: PROTON_CHANNEL },
  { time_tag: "2026-10-12T04:05:00Z", satellite: 18, flux: -1e5, energy: PROTON_CHANNEL }, // fill value
  { time_tag: "2026-10-12T04:06:00Z", satellite: 18, flux: null, energy: PROTON_CHANNEL },
];
const electrons = [{ time_tag: "2026-10-12T04:05:00Z", satellite: 19, flux: 159.9, energy: ELECTRON_CHANNEL }];

async function withFeeds<T>(feeds: { protons?: unknown; electrons?: unknown; status?: number }, fn: () => Promise<T>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (feeds.status && feeds.status !== 200) return new Response("x", { status: feeds.status });
    const body = url.includes("protons") ? feeds.protons : feeds.electrons;
    return new Response(JSON.stringify(body ?? []), { status: 200 });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("GOES: newest valid sample of the S-scale channel; fill and null flux skipped (GAU-112)", () => {
  const r = pickChannel(protons, PROTON_CHANNEL);
  assert.deepEqual(r, { value: 0.25, energy: PROTON_CHANNEL, satellite: "GOES-18", timestamp: "2026-10-12T04:00:00.000Z" });
  assert.equal(pickChannel([], PROTON_CHANNEL), null);
  assert.equal(pickChannel({ not: "an array" }, PROTON_CHANNEL), null);
});

test("GOES: readings past 30 min are unknown, not current (GAU-112)", () => {
  const r = pickChannel(protons, PROTON_CHANNEL)!;
  assert.equal(freshReading(r, now), r);
  assert.equal(freshReading(r, Date.parse(r.timestamp) + PARTICLE_MAX_AGE_MS + 1), null);
  assert.equal(freshReading(null, now), null);
});

test("GOES: status freshness comes from the older channel; failures keep the last real time (GAU-112)", async () => {
  const readout = await withFeeds({ protons, electrons }, () => fetchGoesParticles(now));
  assert.equal(readout?.protons?.value, 0.25);
  assert.equal(readout?.electrons?.value, 159.9);
  let status = getGoesStatus();
  assert.equal(status.healthy, true);
  assert.equal(status.lastSeen, "2026-10-12T04:00:00.000Z", "older of the two channels");
  assert.equal(status.latencySeconds, 600);

  assert.equal(await withFeeds({ status: 503 }, () => fetchGoesParticles(now)), null);
  status = getGoesStatus();
  assert.equal(status.healthy, false);
  assert.equal(status.lastSeen, "2026-10-12T04:00:00.000Z");
  assert.ok(!status.message?.includes("https://"), "no URL in the error");

  const empty = await withFeeds({ protons: [], electrons: [] }, () => fetchGoesParticles(now));
  assert.deepEqual(empty, { protons: null, electrons: null });
  assert.equal(getGoesStatus().healthy, false);
});
