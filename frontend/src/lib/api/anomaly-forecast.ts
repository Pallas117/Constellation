// The 72-hour anomaly forecast behind useAnomalyForecast (`user` role).

export const ANOMALY_FORECAST_PATH = "/api/forecast/anomaly";

export interface AnomalyForecast {
  modelVersion: string;
  generatedAt: string;
  horizonHours: number;
  anomalyProbability: number;
  predictedKpMax: number;
  warningMessage: string;
  confidenceInterval: [number, number];
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Checks the fields the forecast widget formats, so a malformed body counts as
 * a failed poll instead of crashing the panel.
 */
export function parseAnomalyForecast(json: unknown): AnomalyForecast {
  const f = (json ?? {}) as Partial<Record<keyof AnomalyForecast, unknown>>;
  const ci = f.confidenceInterval;
  if (
    typeof f.modelVersion !== "string" ||
    typeof f.generatedAt !== "string" ||
    typeof f.warningMessage !== "string" ||
    !isNumber(f.horizonHours) ||
    !isNumber(f.anomalyProbability) ||
    !isNumber(f.predictedKpMax) ||
    !Array.isArray(ci) ||
    ci.length !== 2 ||
    !isNumber(ci[0]) ||
    !isNumber(ci[1])
  ) {
    throw new Error("Invalid forecast format");
  }
  return {
    modelVersion: f.modelVersion,
    generatedAt: f.generatedAt,
    horizonHours: f.horizonHours,
    anomalyProbability: f.anomalyProbability,
    predictedKpMax: f.predictedKpMax,
    warningMessage: f.warningMessage,
    confidenceInterval: [ci[0], ci[1]],
  };
}
