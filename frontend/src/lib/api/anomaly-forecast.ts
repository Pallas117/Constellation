// The 72-hour anomaly forecast behind useAnomalyForecast (`user` role).

export const ANOMALY_FORECAST_PATH = "/api/forecast/anomaly";

/** Mirrors backend AnomalyForecastResponse: a model forecast, or an explicit "unavailable". */
export type AnomalyForecast =
  | {
      available: true;
      modelVersion: string;
      generatedAt: string;
      horizonHours: number;
      anomalyProbability: number;
      predictedKpMax: number;
      warningMessage: string;
      confidenceInterval: [number, number];
    }
  | {
      available: false;
      modelVersion: null;
      generatedAt: string;
      horizonHours: number;
      reason: string;
    };

type ForecastFields = Partial<Record<"available" | "reason" | keyof Extract<AnomalyForecast, { available: true }>, unknown>>;

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Checks the fields the forecast widget formats, so a malformed body counts as
 * a failed poll instead of crashing the panel. With no trained model the
 * backend answers `available: false` and a reason, which is kept as such.
 */
export function parseAnomalyForecast(json: unknown): AnomalyForecast {
  const f = (json ?? {}) as ForecastFields;
  if (f.available === false) {
    if (typeof f.reason !== "string" || typeof f.generatedAt !== "string" || !isNumber(f.horizonHours)) {
      throw new Error("Invalid forecast format");
    }
    return { available: false, modelVersion: null, generatedAt: f.generatedAt, horizonHours: f.horizonHours, reason: f.reason };
  }
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
    available: true,
    modelVersion: f.modelVersion,
    generatedAt: f.generatedAt,
    horizonHours: f.horizonHours,
    anomalyProbability: f.anomalyProbability,
    predictedKpMax: f.predictedKpMax,
    warningMessage: f.warningMessage,
    confidenceInterval: [ci[0], ci[1]],
  };
}
