import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { heuristicNowcast, inferAnomalyForecast, inferNowcast } from "./client.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";

const point = {
  indices: { kp: 4 },
  magneticField: { z: -6 },
  solarWind: { speed: 520, density: 7 },
  coupling: { newell: 4000 },
} as unknown as CanonicalSpaceWeatherPoint;

async function withEnv<T>(url: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.LOCAL_INFER_URL;
  if (url === undefined) delete process.env.LOCAL_INFER_URL;
  else process.env.LOCAL_INFER_URL = url;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.LOCAL_INFER_URL;
    else process.env.LOCAL_INFER_URL = prev;
  }
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const json = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("no anomaly model: forecast is an explicit unavailable, never a number (GAU-111)", async () => {
  await withEnv(undefined, async () => {
    for (let i = 0; i < 20; i += 1) {
      const f = await inferAnomalyForecast([]);
      assert.equal(f.available, false);
      assert.equal(f.modelVersion, null);
      assert.ok(!("anomalyProbability" in f));
    }
  });
});

test("heuristic nowcast is deterministic, labelled, and claims no confidence (GAU-111)", async () => {
  const now = Date.parse("2026-10-12T00:00:00Z");
  const a = heuristicNowcast({ horizonMinutes: 60, sequence: [point] }, now);
  const b = heuristicNowcast({ horizonMinutes: 60, sequence: [point] }, now);
  assert.deepEqual(a, b, "same input, same output");
  assert.equal(a.method, "heuristic");
  assert.equal(a.modelVersion, "heuristic-nowcast-v0");
  assert.equal(a.predictions.length, 12);
  assert.ok(a.predictions.every((p) => p.confidence === null));
  await withEnv(undefined, async () => {
    assert.equal((await inferNowcast({ horizonMinutes: 60, sequence: [point] })).method, "heuristic");
  });
});

test("inference server failures become unavailable with no URL in the reason (GAU-111)", async () => {
  const url = "http://127.0.0.1:65530";
  await withEnv(url, async () => {
    const cases: Array<[string, typeof fetch]> = [
      ["404", json(404, { error: "Not found" })],
      ["500", json(500, { error: "boom" })],
      ["malformed", json(200, { modelVersion: "x", anomalyProbability: 7 })],
      ["unreachable", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch],
    ];
    for (const [name, impl] of cases) {
      const f = await withFetch(impl, () => inferAnomalyForecast([]));
      assert.equal(f.available, false, name);
      if (!f.available) assert.ok(!f.reason.includes("127.0.0.1"), `${name}: reason leaks the URL`);
    }
  });
});

test("a valid model forecast passes through as available", async () => {
  await withEnv("http://127.0.0.1:65530", async () => {
    const f = await withFetch(
      json(200, {
        modelVersion: "anomaly-gbm-v1",
        anomalyProbability: 0.2,
        predictedKpMax: 4.5,
        warningMessage: "ok",
        confidenceInterval: [0.1, 0.3],
      }),
      () => inferAnomalyForecast([]),
    );
    assert.equal(f.available, true);
    if (f.available) assert.equal(f.anomalyProbability, 0.2);
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

test("the real inference server answers honestly end to end", { skip: !hasPython && "python3 not found" }, async (t) => {
  const server = spawn("python3", ["-I", "ml/infer/infer_server.py"], {
    env: { ...process.env, INFER_HOST: "127.0.0.1", INFER_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => server.kill());
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("inference server did not start")), 10_000);
    server.stdout!.on("data", (chunk: Buffer) => {
      const m = /listening on [\d.]+:(\d+)/.exec(chunk.toString());
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });

  await withEnv(`http://127.0.0.1:${port}`, async () => {
    const forecast = await inferAnomalyForecast([]);
    assert.equal(forecast.available, false, "no trained anomaly model exists yet");
    const nowcast = await inferNowcast({ horizonMinutes: 30, sequence: [point] });
    assert.equal(nowcast.method, "heuristic");
    assert.equal(nowcast.modelVersion, "heuristic-nowcast-v0");
    assert.ok(nowcast.predictions.every((p) => p.confidence === null));
  });
});
