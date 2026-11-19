import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import express from "express";
import { PLANS, type Plan, type PlanLimits } from "./plans.js";
import { createDataApiRouter, type DataProvider } from "./routers.js";
import { CommerceStore } from "./store.js";

// A point shaped like the live feed's (~3.5 KB on the wire), so compression is measured on
// realistic, repetitive JSON.
const point = (i: number) => ({
  timestamp: new Date(Date.parse("2026-11-11T00:00:00Z") + i * 5000).toISOString(),
  source: "NOAA_SWPC",
  solarWind: { speed: 412 + (i % 7), density: 4.1 + (i % 3) / 10, temperature: 81_000 + i },
  magneticField: { bx: 1.2, by: -3.4 + (i % 5) / 10, bz: -2.1, bt: 4.6 },
  indices: { kp: 2.33, dst: -14, kpKind: "planetary-3h" },
  quality: { outlier: false, stale: false, interpolated: false, extrapolated: false, lowConfidence: false, tier: 0 },
  note: "x".repeat(200),
});

const data: DataProvider = {
  latest: async () => point(0),
  history: async (_lookbackMs, limit) => ({ source: "memory", points: Array.from({ length: limit }, (_, i) => point(i)) }),
  sources: () => [{ id: "noaa", ok: true }],
};

async function withApi(plans: Record<Plan, PlanLimits>, fn: (port: number, key: string, clock: { t: number }) => Promise<void>) {
  const store = new CommerceStore(":memory:");
  const key = store.createKey(store.createOrg("Budget Co", "pilot").id, "k", "u").key;
  const clock = { t: Date.parse("2026-11-11T08:00:00Z") };
  const app = express();
  app.use("/api/v1", createDataApiRouter(store, data, () => new Date(clock.t), plans));
  const server = app.listen(0);
  try {
    await fn((server.address() as AddressInfo).port, key, clock);
  } finally {
    server.close();
  }
}

/** Raw GET with node:http (fetch would add Accept-Encoding and decompress for us). */
function get(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on("error", reject);
  });
}

const json = (r: { headers: http.IncomingHttpHeaders; body: Buffer }) => {
  const enc = r.headers["content-encoding"];
  const raw = enc === "gzip" ? gunzipSync(r.body) : enc === "br" ? brotliDecompressSync(r.body) : r.body;
  return JSON.parse(raw.toString("utf8")) as { data: unknown; meta: Record<string, unknown> };
};

test("data API: large replies are compressed when the client accepts it, small ones and plain clients are not", async () => {
  await withApi(PLANS, async (port, key) => {
    const auth = { authorization: `Bearer ${key}` };
    const path = "/api/v1/data/space-weather/history?limit=720";

    const plain = await get(port, path, auth);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers["content-encoding"], undefined, "no Accept-Encoding: identity");
    assert.equal(Number(plain.headers["content-length"]), plain.body.length);
    assert.equal((json(plain).data as unknown[]).length, 720);

    for (const enc of ["gzip", "br"] as const) {
      const r = await get(port, path, { ...auth, "accept-encoding": enc });
      assert.equal(r.headers["content-encoding"], enc);
      assert.match(String(r.headers.vary), /Accept-Encoding/i);
      assert.equal(Number(r.headers["content-length"]), r.body.length);
      assert.deepEqual(json(r).data, json(plain).data, `${enc} decodes to the same body`);
      assert.ok(r.body.length * 10 < plain.body.length, `${enc}: ${r.body.length} B vs ${plain.body.length} B raw`);
    }

    const small = await get(port, "/api/v1/data/sources/status", { ...auth, "accept-encoding": "gzip" });
    assert.equal(small.headers["content-encoding"], undefined, "under 1 KB stays uncompressed");
    assert.deepEqual(json(small).data, [{ id: "noaa", ok: true }]);
  });
});

test("data API: the daily data budget caps history, then refuses until the next UTC day", async () => {
  const plans: Record<Plan, PlanLimits> = { ...PLANS, pilot: { ...PLANS.pilot, pointsPerDay: 10 } };
  await withApi(plans, async (port, key, clock) => {
    const auth = { authorization: `Bearer ${key}` };

    const first = await get(port, "/api/v1/data/space-weather/history?limit=8", auth);
    assert.equal(first.status, 200);
    assert.equal(first.headers["x-points-limit"], "10");
    assert.equal(first.headers["x-points-remaining"], "10");
    assert.equal((json(first).data as unknown[]).length, 8);
    assert.equal(json(first).meta.limitedBy, undefined);

    const second = await get(port, "/api/v1/data/space-weather/history?limit=8", auth);
    assert.equal(second.headers["x-points-remaining"], "2");
    assert.equal((json(second).data as unknown[]).length, 2, "only what is left of the budget");
    assert.equal(json(second).meta.limitedBy, "daily data budget");

    const refused = await get(port, "/api/v1/data/space-weather/latest", auth);
    assert.equal(refused.status, 429);
    assert.match(String((json(refused) as unknown as { error: string }).error), /Daily data budget of 10 points/);

    clock.t += 24 * 60 * 60 * 1000;
    const nextDay = await get(port, "/api/v1/data/space-weather/latest", auth);
    assert.equal(nextDay.status, 200);
    assert.equal(nextDay.headers["x-points-remaining"], "10");
  });
});

test("store: points add up per organisation and day, across keys", () => {
  const store = new CommerceStore(":memory:");
  const org = store.createOrg("Two Keys", "pilot");
  const a = store.createKey(org.id, "a", "u").info.id;
  const b = store.createKey(org.id, "b", "u").info.id;
  const other = store.createKey(store.createOrg("Other", "pilot").id, "c", "u").info.id;
  const at = new Date("2026-11-11T23:59:00Z");
  store.recordPoints(a, 700, at);
  store.recordPoints(b, 300, at);
  store.recordPoints(a, 0, at);
  store.recordPoints(other, 5_000, at);
  store.recordPoints(a, 50, new Date("2026-11-12T00:01:00Z"));
  assert.equal(store.orgPointsOn(org.id, "2026-11-11"), 1_000);
  assert.equal(store.orgPointsOn(org.id, "2026-11-12"), 50);
});
