import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { anomalyForecastConfigured, ForecastNotConfiguredError, inferAnomalyForecast } from "./client.js";
import { anomalyForecastRoute } from "./forecast-route.js";

const app = express();
app.get("/api/forecast/anomaly", anomalyForecastRoute);
const server = app.listen(0);
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/forecast/anomaly`;

const savedInferUrl = process.env.LOCAL_INFER_URL;
test.after(() => {
  server.close();
  if (savedInferUrl === undefined) delete process.env.LOCAL_INFER_URL;
  else process.env.LOCAL_INFER_URL = savedInferUrl;
});

// A stand-in inference service answering POST /infer-anomaly with `status` and `body`.
async function startInferStub(status: number, body: unknown): Promise<{ base: string; paths: string[]; close: () => void }> {
  const paths: string[] = [];
  const stub = http.createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, paths, close: () => stub.close() };
}

const modelForecast = {
  modelVersion: "lstm-anomaly-72h-v1",
  generatedAt: "2026-10-16T00:00:00.000Z",
  horizonHours: 72,
  anomalyProbability: 0.12,
  predictedKpMax: 3.4,
  warningMessage: "Orbital anomalies within normal distribution thresholds.",
  confidenceInterval: [0.05, 0.2],
};

test("without LOCAL_INFER_URL there is no forecast, not a generated one", async () => {
  delete process.env.LOCAL_INFER_URL;
  assert.equal(anomalyForecastConfigured(), false);
  await assert.rejects(inferAnomalyForecast([]), ForecastNotConfiguredError);

  const res = await fetch(url);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "Forecast model not configured" });
});

test("with a model configured the route serves its forecast unchanged", async (t) => {
  const stub = await startInferStub(200, modelForecast);
  t.after(stub.close);
  process.env.LOCAL_INFER_URL = stub.base;
  assert.equal(anomalyForecastConfigured(), true);

  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), modelForecast);
  assert.deepEqual(stub.paths, ["POST /infer-anomaly"]);
});

test("a failing model is a 500, not a fallback forecast", async (t) => {
  const stub = await startInferStub(500, { error: "boom" });
  t.after(stub.close);
  process.env.LOCAL_INFER_URL = stub.base;

  const res = await fetch(url);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "Forecast generation failed" });
});
