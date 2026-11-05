import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { PLANS } from "../commerce/plans.js";
import { createDataApiRouter, MAX_TRUST_BATCH, type DataProvider } from "../commerce/routers.js";
import { CommerceStore } from "../commerce/store.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import { EnvironmentHistory } from "./environment.js";
import type { TrustRecord } from "./record.js";

const NOW = Date.parse("2026-10-20T06:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** A quiet, current point Gauss issued 30 s before NOW. */
const quiet = {
  timestamp: iso(NOW - 30_000),
  observedAt: iso(NOW - 90_000),
  alerts: {
    stormTier: "quiet",
    reason: "",
    radiation: { level: 0, label: "S0", basis: "GOES >=10 MeV protons 0.3 pfu", observedAt: iso(NOW - 5 * 60_000) },
    geomagnetic: { level: 0, label: "G0", basis: "Kp 1.67", observedAt: iso(NOW - 3_600_000) },
    radioBlackout: { level: 0, label: "R0", basis: "GOES 0.1-0.8nm X-rays B5", observedAt: iso(NOW - 60_000) },
  },
  particles: { protons: { value: 0.3, energy: ">=10 MeV", satellite: "GOES-18", timestamp: iso(NOW - 5 * 60_000) }, electrons: null },
  indices: { kp: 1.67, dst: -12, dstMethod: "measured", dstDerivedFrom: [], kpKind: "planetary-3h", kpObservedAt: iso(NOW - 3_600_000), dstObservedAt: iso(NOW - 40 * 60_000) },
  quality: { outlier: false, stale: false, interpolated: false, extrapolated: false, lowConfidence: false, tier: 0 },
  senseChecks: [],
} as unknown as CanonicalSpaceWeatherPoint;

const provider = (withEnvironment = true): DataProvider => ({
  latest: async () => null,
  history: async () => ({ source: "memory", points: [] }),
  sources: () => [],
  ...(withEnvironment ? { environment: () => new EnvironmentHistory([quiet], "live feed") } : {}),
});

async function withApi(fn: (base: string, keys: { pilot: string; free: string }, store: CommerceStore) => Promise<void>, withEnvironment = true) {
  const store = new CommerceStore(":memory:");
  const pilot = store.createKey(store.createOrg("xOrbita", "pilot").id, "ops", "u").key;
  const free = store.createKey(store.createOrg("Free Co", "free").id, "k", "u").key;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/v1", createDataApiRouter(store, provider(withEnvironment), () => new Date(NOW), PLANS));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/data/trust/records`, { pilot, free }, store);
  } finally {
    server.close();
  }
}

const post = (url: string, key: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });

const inference = (over: Record<string, unknown> = {}) => ({ time: iso(NOW - 10_000), spacecraftId: "AVERA-1", modelId: "atlas-v2", output: { label: "cloud" }, confidence: 0.9, ...over });

test("trust records API: one inference returns its record, metered to the organisation (GAU-57)", async () => {
  await withApi(async (url, keys, store) => {
    const res = await post(url, keys.pilot, inference());
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: TrustRecord; meta: { org: string } };
    assert.equal(body.data.verdict.value, "consistent");
    assert.equal(body.data.environmentSource, "live feed");
    assert.equal(body.meta.org, "xOrbita");
    const org = store.resolveKey(keys.pilot)!.org;
    assert.equal(store.orgUsageOn(org.id, "2026-10-20"), 1);
  });
});

test("trust records API: an invalid inference is a 400 listing every error, nothing guessed (GAU-57)", async () => {
  await withApi(async (url, keys) => {
    const res = await post(url, keys.pilot, { time: "soon", modelId: "" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { errors: string[] };
    assert.deepEqual(body.errors, ["time must be an ISO 8601 timestamp", "spacecraftId must be 1–128 characters", "modelId must be 1–128 characters"]);
  });
});

test("trust records API: a batch returns records for valid items and the errors for the rest (GAU-57)", async () => {
  await withApi(async (url, keys) => {
    const res = await post(url, keys.pilot, {
      inferences: [inference(), inference({ spacecraftId: "" }), inference({ time: iso(NOW - 25 * 3_600_000) }), inference({ time: iso(NOW - 20 * 3_600_000) })],
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: TrustRecord[]; rejected: Array<{ index: number; errors: string[] }>; meta: { count: number } };
    assert.equal(body.meta.count, 2);
    assert.deepEqual(body.data.map((r) => r.verdict.value), ["consistent", "unknown"], "20 h ago has no reading in this history: unknown, not consistent");
    assert.deepEqual(body.rejected.map((r) => r.index), [1, 2]);
    assert.match(body.rejected[1].errors[0], /older than this plan's lookback/);
  });
});

test("trust records API: batch size is bounded, the free plan has no access, and keys are required (GAU-57)", async () => {
  await withApi(async (url, keys) => {
    const tooMany = await post(url, keys.pilot, { inferences: Array.from({ length: MAX_TRUST_BATCH + 1 }, () => inference()) });
    assert.equal(tooMany.status, 400);
    assert.equal((await post(url, keys.free, inference())).status, 403);
    assert.equal((await post(url, "gk_not_a_key", inference())).status, 401);
  });
});

test("trust records API: a server without an environment history says so, never an empty record (GAU-57)", async () => {
  await withApi(async (url, keys) => {
    const res = await post(url, keys.pilot, inference());
    assert.equal(res.status, 503);
  }, false);
});
