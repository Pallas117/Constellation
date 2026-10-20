import assert from "node:assert/strict";
import test from "node:test";
import {
  ELECTRON_CHANNEL,
  PARTICLE_MAX_AGE_MS,
  PROTON_CHANNEL,
  XRAY_MAX_AGE_MS,
  checkXray,
  fetchGoesParticles,
  freshReading,
  freshXray,
  getGoesStatus,
  pickChannel,
  pickXray,
  spectrumAt,
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

async function withFeeds<T>(feeds: { protons?: unknown; electrons?: unknown; xrays?: unknown; status?: number }, fn: () => Promise<T>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (feeds.status && feeds.status !== 200) return new Response("x", { status: feeds.status });
    if (url.includes("xrays") && feeds.xrays === undefined) return new Response("x", { status: 404 });
    const body = url.includes("protons") ? feeds.protons : url.includes("xrays") ? feeds.xrays : feeds.electrons;
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
  assert.equal(empty?.protons, null);
  assert.equal(empty?.electrons, null);
  assert.equal(empty?.xray, null, "X-ray feed failed: no reading");
  assert.deepEqual(
    empty?.checks?.map((c) => [c.id, c.status]),
    [["goes-proton-spectrum", "unknown"], ["goes-proton-channels", "unknown"], ["goes-xray", "unknown"]],
    "nothing to check is unknown, never pass",
  );
  assert.equal(getGoesStatus().healthy, false);
});

const step = (time: string, fluxes: Record<string, number | null>) =>
  Object.entries(fluxes).map(([energy, flux]) => ({ time_tag: time, satellite: 18, flux, energy }));

test("GOES: the spectrum is read from one time step, the newest with at least two channels (GAU-136)", () => {
  const data = [
    ...step("2026-10-19T08:35:00Z", { ">=10 MeV": 0.27, ">=50 MeV": 0.25, ">=100 MeV": 0.24 }),
    ...step("2026-10-19T08:40:00Z", { ">=10 MeV": 0.26, ">=50 MeV": -1e5, ">=100 MeV": 0.23 }),
    ...step("2026-10-19T08:45:00Z", { ">=10 MeV": 0.25 }), // the other channels haven't arrived yet
  ];
  const spectrum = spectrumAt(data);
  assert.deepEqual(spectrum.map((r) => r?.value ?? null), [0.26, null, 0.23], "08:40, with the fill as a gap");
  assert.ok(spectrum.every((r) => r === null || r.timestamp === "2026-10-19T08:40:00.000Z"));
  assert.deepEqual(spectrumAt([]), [null, null, null]);
});

const xrays = [
  { time_tag: "2026-10-19T08:43:00Z", satellite: 18, flux: 5.7e-7, energy: "0.1-0.8nm", electron_contaminaton: false },
  { time_tag: "2026-10-19T08:44:00Z", satellite: 18, flux: 1.2e-8, energy: "0.05-0.4nm", electron_contaminaton: false },
  { time_tag: "2026-10-19T08:44:00Z", satellite: 18, flux: 5.66e-7, energy: "0.1-0.8nm", electron_contaminaton: false },
  { time_tag: "2026-10-19T08:45:00Z", satellite: 18, flux: 0, energy: "0.1-0.8nm", electron_contaminaton: false },
];

test("GOES X-rays: newest valid long-band sample with its flare class; zero and fills skipped (GAU-136)", () => {
  assert.deepEqual(pickXray(xrays), {
    value: 5.66e-7,
    band: "0.1-0.8nm",
    flareClass: "B5.6",
    satellite: "GOES-18",
    timestamp: "2026-10-19T08:44:00.000Z",
  });
  const reading = pickXray(xrays)!;
  assert.equal(freshXray(reading, Date.parse(reading.timestamp) + XRAY_MAX_AGE_MS), reading);
  assert.equal(freshXray(reading, Date.parse(reading.timestamp) + XRAY_MAX_AGE_MS + 1), null, "past 15 min: unknown");
});

test("GOES X-rays: NOAA's electron-contamination mark on the newest sample is flagged (GAU-136)", () => {
  const clean = checkXray(xrays.slice(0, 3));
  assert.equal(clean.status, "pass");
  const contaminated = checkXray([...xrays.slice(0, 2), { ...xrays[2], electron_contaminaton: true }]);
  assert.equal(contaminated.status, "flag");
  assert.match(contaminated.reason, /electron-contaminated/);
});

test("GOES: a fetch carries the spectrum, channel and X-ray checks, and an R-scale input (GAU-136)", async () => {
  const protonSteps = [
    ...step("2026-10-12T04:00:00Z", { ">=10 MeV": 3, ">=50 MeV": 12, ">=100 MeV": 2 }),
  ];
  const readout = await withFeeds({ protons: protonSteps, electrons, xrays: xrays.slice(0, 3) }, () => fetchGoesParticles(now));
  const byId = new Map(readout?.checks?.map((c) => [c.id, c]));
  assert.equal(byId.get("goes-proton-spectrum")?.status, "flag", ">=50 MeV above >=10 MeV");
  assert.equal(byId.get("goes-proton-channels")?.status, "pass");
  assert.equal(byId.get("goes-xray")?.status, "pass");
  assert.equal(readout?.xray?.flareClass, "B5.6");
});
