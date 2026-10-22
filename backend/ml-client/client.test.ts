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

test("no inference server: forecast is an explicit unavailable, never a number (GAU-111)", async () => {
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
        horizonHours: 3,
        anomalyProbability: 0.2,
        predictedKpMax: 4.5,
        warningMessage: "ok",
        confidenceInterval: [0.1, 0.3],
      }),
      () => inferAnomalyForecast([]),
    );
    assert.equal(f.available, true);
    if (f.available) {
      assert.equal(f.anomalyProbability, 0.2);
      assert.equal(f.horizonHours, 3, "the model's own horizon, never relabelled as 72 h");
    }
    const noHorizon = await withFetch(
      json(200, { modelVersion: "x", anomalyProbability: 0.2, predictedKpMax: 4, confidenceInterval: [0.1, 0.3] }),
      () => inferAnomalyForecast([]),
    );
    assert.equal(noHorizon.available, false);
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

test("the real inference server serves the promoted Kp model, honestly (GAU-113)", { skip: !hasPython && "python3 not found" }, async (t) => {
  const server = spawn("python3", ["-I", "ml/infer/infer_server.py"], {
    env: { ...process.env, INFER_HOST: "127.0.0.1", INFER_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => server.kill());
  const port = await new Promise<number>((resolve, reject) => {
    // Startup is about 1 s alone, but under the full suite at memory pressure a cold Python import
    // overran 10 s (2026-10-21). This test is about serving honestly, not startup speed.
    const timer = setTimeout(() => reject(new Error("inference server did not start within 30 s")), 30_000);
    server.stdout!.on("data", (chunk: Buffer) => {
      const m = /listening on [\d.]+:(\d+)/.exec(chunk.toString());
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });

  // Six hours of 1-minute points ending now, with the given drivers.
  const history = (drivers: { bz: number; by: number; speed: number; density: number; pressure: number; kp: number }, stale = false) =>
    Array.from({ length: 6 * 60 }, (_, i) => ({
      timestamp: new Date(Date.now() - (6 * 60 - 1 - i) * 60_000).toISOString(),
      solarWind: { speed: drivers.speed, density: drivers.density, dynamicPressure: drivers.pressure },
      magneticField: { x: 0, y: drivers.by, z: drivers.bz },
      indices: { kp: drivers.kp },
      quality: { stale },
    }));

  await withEnv(`http://127.0.0.1:${port}`, async () => {
    const empty = await inferAnomalyForecast([]);
    assert.equal(empty.available, false);
    if (!empty.available) assert.match(empty.reason, /Needs 6 h/);

    const quiet = await inferAnomalyForecast(history({ bz: 3, by: 1, speed: 340, density: 4, pressure: 1, kp: 1 }));
    const storm = await inferAnomalyForecast(history({ bz: -20, by: 5, speed: 750, density: 20, pressure: 15, kp: 6 }));
    assert.equal(quiet.available, true, "a promoted model with 6 h of history answers");
    assert.equal(storm.available, true);
    if (quiet.available && storm.available) {
      assert.match(quiet.modelVersion, /^kp3h-mlp-v1-/);
      assert.equal(quiet.horizonHours, 3);
      assert.ok(quiet.anomalyProbability < 0.1, `quiet wind: P=${quiet.anomalyProbability}`);
      assert.ok(storm.anomalyProbability > 0.5, `strong southward driving: P=${storm.anomalyProbability}`);
      assert.ok(storm.predictedKpMax > quiet.predictedKpMax);
      assert.ok(storm.confidenceInterval[0] <= storm.anomalyProbability && storm.anomalyProbability <= storm.confidenceInterval[1]);
    }

    const stale = await inferAnomalyForecast(history({ bz: -20, by: 5, speed: 750, density: 20, pressure: 15, kp: 6 }, true));
    assert.equal(stale.available, false, "stale points are not measurements");

    const nowcast = await inferNowcast({ horizonMinutes: 30, sequence: [point] });
    assert.equal(nowcast.method, "heuristic");
    assert.equal(nowcast.modelVersion, "heuristic-nowcast-v0");
    assert.ok(nowcast.predictions.every((p) => p.confidence === null));
  });
});

test("Kp model unit tests (python)", { skip: !hasPython && "python3 not found" }, () => {
  const result = spawnSync("python3", ["-I", "ml/tests/test_kp_model.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("inference server request handling (python)", { skip: !hasPython && "python3 not found" }, () => {
  const result = spawnSync("python3", ["-I", "ml/tests/test_infer_server.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("nightly incremental count and skip-if-unchanged (python)", { skip: !hasPython && "python3 not found" }, () => {
  const result = spawnSync("python3", ["-I", "ml/tests/test_nightly.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("OMNI matrix cache and zero-copy windows match the old results exactly (python)", { skip: !hasPython && "python3 not found" }, () => {
  const result = spawnSync("python3", ["-I", "ml/tests/test_omni_matrix.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
