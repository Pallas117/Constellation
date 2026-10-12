import { spawn } from "node:child_process";
import type {
  NowcastInferenceRequest,
  NowcastInferenceResponse,
  AnomalyForecastResponse,
  AnomalyForecastUnavailable,
} from "../types.js";

const HEURISTIC_VERSION = "heuristic-nowcast-v0";
const ANOMALY_HORIZON_HOURS = 72;
export const INFER_TIMEOUT_MS = 10_000;

export async function inferNowcast(
  request: NowcastInferenceRequest,
): Promise<NowcastInferenceResponse> {
  const inferUrl = process.env.LOCAL_INFER_URL;
  if (!inferUrl) {
    return heuristicNowcast(request);
  }

  const response = await fetch(`${inferUrl}/infer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(INFER_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Inference server error ${response.status}`);
  }

  const body = (await response.json()) as Partial<NowcastInferenceResponse>;
  // A server that does not say it ran trained weights is treated as a heuristic.
  return { ...body, method: body.method === "model" ? "model" : "heuristic" } as NowcastInferenceResponse;
}

/**
 * Fixed-formula nowcast used when no inference server is configured. Deterministic: the same
 * input always gives the same output. It has no learned parameters, so it reports no confidence.
 */
export function heuristicNowcast(
  request: NowcastInferenceRequest,
  now: number = Date.now(),
): NowcastInferenceResponse {
  const last = request.sequence[request.sequence.length - 1];
  const kpBase = last?.indices.kp ?? 2;
  const bz = last?.magneticField.z ?? 0;
  const speed = last?.solarWind.speed ?? 400;
  const density = last?.solarWind.density ?? 5;
  const coupling = last?.coupling.newell ?? 0;

  const steps = Math.max(1, Math.min(24, Math.floor(request.horizonMinutes / 5)));
  const driver = Math.max(0, -bz) * 0.45 + (speed - 350) * 0.004 + density * 0.05 + coupling / 8000;

  const predictions = Array.from({ length: steps }, (_, i) => {
    const minutes = (i + 1) * 5;
    return {
      timestamp: new Date(now + minutes * 60 * 1000).toISOString(),
      geomagneticPerturbation: kpBase * 8 + driver * 12,
      auroraIntensity: Math.max(0.05, Math.min(1, (kpBase / 9) * 0.7 + driver * 0.03)),
      confidence: null,
    };
  });

  return {
    modelVersion: HEURISTIC_VERSION,
    method: "heuristic",
    generatedAt: new Date(now).toISOString(),
    horizonMinutes: request.horizonMinutes,
    predictions,
  };
}

function unavailable(reason: string): AnomalyForecastUnavailable {
  return {
    available: false,
    modelVersion: null,
    generatedAt: new Date().toISOString(),
    horizonHours: ANOMALY_HORIZON_HOURS,
    reason,
  };
}

function isProbability(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
}

/**
 * 72-hour anomaly forecast from a trained model served at LOCAL_INFER_URL. With no model, or a
 * model that cannot answer, the result is an explicit "unavailable"; no number is ever invented.
 */
export async function inferAnomalyForecast(
  historicalData: unknown[],
): Promise<AnomalyForecastResponse> {
  const inferUrl = process.env.LOCAL_INFER_URL;
  if (!inferUrl) {
    return unavailable("No trained anomaly model is deployed.");
  }

  let response: Response;
  try {
    response = await fetch(`${inferUrl}/infer-anomaly`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sequence: historicalData, horizonHours: ANOMALY_HORIZON_HOURS }),
      signal: AbortSignal.timeout(INFER_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return unavailable(timedOut ? "Inference server timed out." : "Inference server unreachable.");
  }

  if (response.status === 404 || response.status === 501) {
    return unavailable("Inference server has no anomaly model.");
  }
  if (!response.ok) {
    return unavailable(`Inference server error ${response.status}.`);
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.available === false) {
    return unavailable(typeof body.reason === "string" ? body.reason.slice(0, 200) : "Model unavailable.");
  }
  const ci = body?.confidenceInterval;
  const kp = body?.predictedKpMax;
  if (
    !body ||
    typeof body.modelVersion !== "string" ||
    !isProbability(body.anomalyProbability) ||
    typeof kp !== "number" || !Number.isFinite(kp) || kp < 0 || kp > 9 ||
    !Array.isArray(ci) || ci.length !== 2 || !isProbability(ci[0]) || !isProbability(ci[1])
  ) {
    return unavailable("Inference server returned a malformed forecast.");
  }
  // The model states its own horizon (e.g. 3 h from L1 solar wind); never relabel it.
  const horizon = body.horizonHours;
  if (typeof horizon !== "number" || !Number.isFinite(horizon) || horizon <= 0 || horizon > ANOMALY_HORIZON_HOURS) {
    return unavailable("Inference server returned a forecast without a valid horizon.");
  }
  return {
    available: true,
    modelVersion: body.modelVersion,
    generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : new Date().toISOString(),
    horizonHours: horizon,
    anomalyProbability: body.anomalyProbability,
    predictedKpMax: kp,
    warningMessage: typeof body.warningMessage === "string" ? body.warningMessage : "",
    confidenceInterval: [ci[0], ci[1]],
  };
}

export async function triggerTraining(): Promise<{ started: boolean; pid?: number; message: string }> {
  return new Promise((resolve) => {
    const script = process.env.TRAINING_SCRIPT_PATH ?? "ml/train/train_kp.py";
    const child = spawn("python3", [script], {
      stdio: "ignore",
      detached: true,
    });

    child.on("error", (error) => {
      resolve({ started: false, message: `Failed to start training: ${error.message}` });
    });

    child.unref();
    resolve({ started: true, pid: child.pid, message: "Training started" });
  });
}
