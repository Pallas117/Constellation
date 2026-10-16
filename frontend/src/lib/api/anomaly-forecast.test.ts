import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAnomalyForecast } from "./anomaly-forecast.ts";

const forecast = {
  modelVersion: "lstm-v1-local",
  generatedAt: "2026-10-15T10:00:00.000Z",
  horizonHours: 72,
  anomalyProbability: 0.21,
  predictedKpMax: 4.2,
  warningMessage: "Orbital anomalies within normal distribution thresholds.",
  confidenceInterval: [0.06, 0.36],
};

describe("parseAnomalyForecast", () => {
  it("returns the fields the widget formats", () => {
    assert.deepEqual(parseAnomalyForecast({ ...forecast, extra: "ignored" }), { available: true, ...forecast });
    assert.deepEqual(parseAnomalyForecast({ available: true, ...forecast }), { available: true, ...forecast });
  });

  it("keeps the backend's explicit unavailable instead of failing the poll", () => {
    const unavailable = {
      available: false,
      modelVersion: null,
      generatedAt: "2026-10-15T10:00:00.000Z",
      horizonHours: 72,
      reason: "No trained anomaly model is deployed.",
    };
    assert.deepEqual(parseAnomalyForecast({ ...unavailable, anomalyProbability: 0.5 }), unavailable);
    assert.throws(() => parseAnomalyForecast({ ...unavailable, reason: undefined }), /Invalid forecast format/);
  });

  it("throws on the backend's error body and on fields the widget would crash on", () => {
    assert.throws(() => parseAnomalyForecast({ error: "Forecast generation failed" }), /Invalid forecast format/);
    assert.throws(() => parseAnomalyForecast(null), /Invalid forecast format/);
    assert.throws(() => parseAnomalyForecast({ ...forecast, predictedKpMax: "4.2" }), /Invalid forecast format/);
    assert.throws(() => parseAnomalyForecast({ ...forecast, anomalyProbability: Number.NaN }), /Invalid forecast format/);
    assert.throws(() => parseAnomalyForecast({ ...forecast, confidenceInterval: [0.1] }), /Invalid forecast format/);
    assert.throws(() => parseAnomalyForecast({ ...forecast, warningMessage: undefined }), /Invalid forecast format/);
  });
});
