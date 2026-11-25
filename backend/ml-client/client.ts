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

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Points per inference request: 24 h at the 5 s feed cadence. */
export const MAX_NOWCAST_SEQUENCE = 17_280;
/** Nowcast horizon bounds, in minutes. */
export const NOWCAST_HORIZON_MIN = 5;
export const NOWCAST_HORIZON_MAX = 180;

/**
 * The body of POST /api/ai/nowcast/infer: `{ sequence?, horizonMinutes? }`. The sequence is a list
 * of plain objects (canonical points; missing fields fall back in the heuristic, the inference
 * server checks its own input). A non-numeric horizon used to become NaN and an empty prediction.
 */
export function parseNowcastRequest(
  body: unknown,
): { ok: true; sequence: NowcastInferenceRequest["sequence"]; horizonMinutes: number } | { ok: false; error: string } {
  const input = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const sequence = input.sequence ?? [];
  if (!Array.isArray(sequence) || sequence.length > MAX_NOWCAST_SEQUENCE) {
    return { ok: false, error: `sequence must be a list of up to ${MAX_NOWCAST_SEQUENCE} points` };
  }
  if (!sequence.every((p) => p !== null && typeof p === "object" && !Array.isArray(p))) {
    return { ok: false, error: "each sequence point must be an object" };
  }
  const rawHorizon = input.horizonMinutes ?? 60;
  const horizon = typeof rawHorizon === "number" || typeof rawHorizon === "string" ? Number(rawHorizon) : Number.NaN;
  if (!Number.isFinite(horizon)) return { ok: false, error: "horizonMinutes must be a number" };
  return {
    ok: true,
    sequence: sequence as NowcastInferenceRequest["sequence"],
    horizonMinutes: Math.max(NOWCAST_HORIZON_MIN, Math.min(horizon, NOWCAST_HORIZON_MAX)),
  };
}

/**
 * Fixed-formula nowcast used when no inference server is configured. Deterministic: the same
 * input always gives the same output. It has no learned parameters, so it reports no confidence.
 * Both outputs start from the latest Kp; with no Kp reading they are null (unknown), not
 * computed from an assumed Kp (GAU-230).
 */
export function heuristicNowcast(
  request: NowcastInferenceRequest,
  now: number = Date.now(),
): NowcastInferenceResponse {
  const last = request.sequence[request.sequence.length - 1];
  // The sequence can come from a request body: read Kp defensively and accept only a finite 0–9 value.
  const kpRead: unknown = last?.indices?.kp;
  const kpBase = typeof kpRead === "number" && Number.isFinite(kpRead) && kpRead >= 0 && kpRead <= 9 ? kpRead : null;
  // Every field may be missing or the wrong type in a posted point: a TypeError here was a 500.
  const bz = finiteOr(last?.magneticField?.z, 0); // nT, GSM
  const speed = finiteOr(last?.solarWind?.speed, 400); // km/s
  const density = finiteOr(last?.solarWind?.density, 5); // cm^-3
  const coupling = finiteOr(last?.coupling?.newell, 0);

  const steps = Math.max(1, Math.min(24, Math.floor(request.horizonMinutes / 5)));
  const driver = Math.max(0, -bz) * 0.45 + (speed - 350) * 0.004 + density * 0.05 + coupling / 8000;

  const predictions = Array.from({ length: steps }, (_, i) => {
    const minutes = (i + 1) * 5;
    return {
      timestamp: new Date(now + minutes * 60 * 1000).toISOString(),
      geomagneticPerturbation: kpBase === null ? null : kpBase * 8 + driver * 12,
      auroraIntensity: kpBase === null ? null : Math.max(0.05, Math.min(1, (kpBase / 9) * 0.7 + driver * 0.03)),
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

/**
 * Starts the training script in the background. Resolves once the process has either started or
 * failed to start: `spawn` reports a missing interpreter or script asynchronously, and resolving
 * "started" straight away used to answer "Training started" even when nothing ran. The message is
 * fixed text: an error's message names local paths, so only its code goes to the log.
 */
export async function triggerTraining(
  options: { command?: string; script?: string } = {},
): Promise<{ started: boolean; pid?: number; message: string }> {
  return new Promise((resolve) => {
    const script = options.script ?? process.env.TRAINING_SCRIPT_PATH ?? "ml/train/train_kp.py";
    const child = spawn(options.command ?? "python3", [script], {
      stdio: "ignore",
      detached: true,
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      console.error(`[training] could not start (${error.code ?? error.name})`);
      resolve({ started: false, message: "Training could not be started" });
    });
    child.once("spawn", () => {
      child.unref();
      resolve({ started: true, pid: child.pid, message: "Training started" });
    });
  });
}
