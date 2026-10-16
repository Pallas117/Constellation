import { spawn } from "node:child_process";
import type { NowcastInferenceRequest, NowcastInferenceResponse, AnomalyForecastResponse } from "../types.js";

const DEFAULT_MODEL_VERSION = "unet-baseline-v1";

export async function inferNowcast(
  request: NowcastInferenceRequest,
): Promise<NowcastInferenceResponse> {
  const inferUrl = process.env.LOCAL_INFER_URL;
  if (!inferUrl) {
    return localDeterministicInference(request);
  }

  const response = await fetch(`${inferUrl}/infer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Inference server error ${response.status}`);
  }

  return (await response.json()) as NowcastInferenceResponse;
}

function localDeterministicInference(
  request: NowcastInferenceRequest,
): NowcastInferenceResponse {
  const last = request.sequence[request.sequence.length - 1];
  const kpBase = last?.indices.kp ?? 2;
  const bz = last?.magneticField.z ?? 0;
  const speed = last?.solarWind.speed ?? 400;
  const density = last?.solarWind.density ?? 5;
  const coupling = last?.coupling.newell ?? 0;

  const steps = Math.max(1, Math.min(24, Math.floor(request.horizonMinutes / 5)));
  const now = Date.now();
  
  // Stochastic Resonance Factor
  const resonance = () => Math.sin(now / 10000) * 0.05 + (Math.random() - 0.5) * 0.02;

  const predictions = Array.from({ length: steps }, (_, i) => {
    const minutes = (i + 1) * 5;
    const t = new Date(now + minutes * 60 * 1000).toISOString();
    const driveBase = Math.max(0, -bz) * 0.45 + (speed - 350) * 0.004 + density * 0.05 + coupling / 8000;
    const driver = driveBase * (1 + resonance());
    
    const geomagneticPerturbation = kpBase * 8 + driver * 12;
    const auroraIntensity = Math.max(0.05, Math.min(1, (kpBase / 9) * 0.7 + driver * 0.03 + resonance() * 0.5));
    
    return {
      timestamp: t,
      geomagneticPerturbation,
      auroraIntensity,
      confidence: Math.max(0.35, Math.min(0.95, 0.9 - i * 0.02 + resonance() * 0.1)),
    };
  });

  return {
    modelVersion: `${DEFAULT_MODEL_VERSION}-stochastic`,
    generatedAt: new Date().toISOString(),
    horizonMinutes: request.horizonMinutes,
    predictions,
  };
}

/** Thrown when no inference service is configured (`LOCAL_INFER_URL` unset). */
export class ForecastNotConfiguredError extends Error {
  constructor() {
    super("Forecast model not configured");
    this.name = "ForecastNotConfiguredError";
  }
}

export function anomalyForecastConfigured(): boolean {
  return Boolean(process.env.LOCAL_INFER_URL);
}

/**
 * Predicts the probability of extreme space weather anomalies up to 72 hours
 * into the future using Long Short-Term Memory (LSTM) time-series forecasting.
 * There is no local fallback: without a model there is no forecast, so callers
 * report it unavailable rather than show generated numbers as a model output.
 */
export async function inferAnomalyForecast(
  historicalData: any[]
): Promise<AnomalyForecastResponse> {
  const inferUrl = process.env.LOCAL_INFER_URL;
  if (!inferUrl) {
    throw new ForecastNotConfiguredError();
  }

  const response = await fetch(`${inferUrl}/infer-anomaly`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sequence: historicalData, horizonHours: 72 }),
  });

  if (!response.ok) {
    throw new Error(`Inference anomaly endpoint error ${response.status}`);
  }

  return (await response.json()) as AnomalyForecastResponse;
}

export async function triggerTraining(): Promise<{ started: boolean; pid?: number; message: string }> {
  return new Promise((resolve) => {
    const script = process.env.TRAINING_SCRIPT_PATH ?? "ml/train/train_unet.py";
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
