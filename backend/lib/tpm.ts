/**
 * Technical performance measures (TPMs) with thresholds and margins (GAU-122).
 * NASA SP-2016-6105 Rev 2 §6.7: track key measures against limits and watch the remaining margin.
 */

export type TpmStatus = "green" | "amber" | "red" | "insufficient";

export interface TpmSpec {
  id: string;
  title: string;
  unit: string;
  /** "max": lower is better (value must stay below limits). "min": higher is better. */
  direction: "max" | "min";
  amber: number;
  red: number;
  /** FMEA rows this measure detects. */
  fmea: string[];
}

export interface TpmReading extends TpmSpec {
  value: number | null;
  status: TpmStatus;
  /** Distance to the red limit, in `unit` (positive = margin left). Null when insufficient. */
  marginToRed: number | null;
  note?: string;
}

export const TPM_SPECS: TpmSpec[] = [
  { id: "data_age", title: "Age of newest measurement", unit: "s", direction: "max", amber: 600, red: 900, fmea: ["FM-01"] },
  { id: "loop_liveness", title: "Time since last completed ingest tick", unit: "s", direction: "max", amber: 10, red: 15, fmea: ["FM-03", "FM-13"] },
  { id: "tick_p95", title: "Ingest tick p95 latency", unit: "ms", direction: "max", amber: 2000, red: 5000, fmea: ["FM-02"] },
  { id: "persist_failures", title: "Failed telemetry writes since start", unit: "count", direction: "max", amber: 1, red: 10, fmea: ["FM-10"] },
  { id: "disk_free", title: "Free disk on the data volume", unit: "GB", direction: "min", amber: 10, red: 3, fmea: ["FM-14"] },
  { id: "memory_rss", title: "Backend resident memory", unit: "MB", direction: "max", amber: 1024, red: 2048, fmea: ["FM-15"] },
  { id: "official_sources_down", title: "Official sources unhealthy (NOAA, GOES, Kyoto)", unit: "count", direction: "max", amber: 1, red: 2, fmea: ["FM-01"] },
  { id: "forecast_skill", title: "Live Kp-forecast skill vs persistence (1 - MAE/MAE_persist)", unit: "ratio", direction: "min", amber: 0.05, red: 0, fmea: ["FM-09"] },
];

export function evaluate(spec: TpmSpec, value: number | null, note?: string): TpmReading {
  if (value === null || !Number.isFinite(value)) {
    return { ...spec, value: null, status: "insufficient", marginToRed: null, note };
  }
  const worse = (a: number, b: number) => (spec.direction === "max" ? a >= b : a <= b);
  const status: TpmStatus = worse(value, spec.red) ? "red" : worse(value, spec.amber) ? "amber" : "green";
  const marginToRed = spec.direction === "max" ? spec.red - value : value - spec.red;
  return { ...spec, value, status, marginToRed, note };
}

/** Worst status across readings; "insufficient" never hides a red or amber. */
export function overall(readings: TpmReading[]): TpmStatus {
  const order: TpmStatus[] = ["red", "amber", "insufficient", "green"];
  return order.find((s) => readings.some((r) => r.status === s)) ?? "green";
}

interface PendingForecast {
  issuedAt: number;
  targetAt: number;
  predictedKp: number;
  persistenceKp: number;
}

/**
 * Scores each served forecast against the Kp observed at its target time, and keeps a rolling
 * comparison with persistence (Kp stays as it was when the forecast was issued). FM-09.
 */
export class ForecastSkillTracker {
  private pending: PendingForecast[] = [];
  private resolved: Array<{ errModel: number; errPersist: number }> = [];

  constructor(
    private readonly minSamples = 20,
    private readonly window = 200,
    private readonly maxPending = 500,
  ) {}

  /** Record a served forecast issued at `issuedAt` for `horizonHours` ahead. */
  record(issuedAt: number, horizonHours: number, predictedKp: number, kpNow: number): void {
    if (![issuedAt, horizonHours, predictedKp, kpNow].every(Number.isFinite)) return;
    this.pending.push({ issuedAt, targetAt: issuedAt + horizonHours * 3_600_000, predictedKp, persistenceKp: kpNow });
    if (this.pending.length > this.maxPending) this.pending.shift();
  }

  /**
   * Resolve every pending forecast whose target time has passed, using the Kp observed at `nowMs`.
   * Only call with a current measured Kp (not stale or defaulted).
   */
  resolve(nowMs: number, observedKp: number): number {
    if (!Number.isFinite(observedKp)) return 0;
    const due = this.pending.filter((p) => p.targetAt <= nowMs);
    this.pending = this.pending.filter((p) => p.targetAt > nowMs);
    for (const p of due) {
      this.resolved.push({ errModel: Math.abs(p.predictedKp - observedKp), errPersist: Math.abs(p.persistenceKp - observedKp) });
    }
    if (this.resolved.length > this.window) this.resolved.splice(0, this.resolved.length - this.window);
    return due.length;
  }

  /** 1 - MAE_model / MAE_persistence over the rolling window, or null until minSamples have resolved. */
  skill(): { value: number | null; samples: number; maeModel: number | null; maePersistence: number | null } {
    const n = this.resolved.length;
    if (n < this.minSamples) return { value: null, samples: n, maeModel: null, maePersistence: null };
    const maeModel = this.resolved.reduce((s, r) => s + r.errModel, 0) / n;
    const maePersistence = this.resolved.reduce((s, r) => s + r.errPersist, 0) / n;
    // Perfect persistence (MAE 0) leaves nothing to beat: report 0 rather than divide by zero.
    const value = maePersistence > 0 ? 1 - maeModel / maePersistence : 0;
    return { value, samples: n, maeModel, maePersistence };
  }
}

export interface TpmInputs {
  pipeline: { dataAgeMs: number | null; lastTickAgeMs: number | null; stages: Array<{ stage: string; p95Ms: number; samples: number }> };
  failedWrites: number;
  diskFreeBytes: number | null;
  rssBytes: number;
  sources: Array<{ source: string; healthy: boolean }>;
  skill: { value: number | null; samples: number; maeModel: number | null; maePersistence: number | null };
}

const OFFICIAL_SOURCES = ["noaa-swpc", "goes-swpc", "kyoto-dst"];
export const MIN_TICK_SAMPLES = 20;

export function readTpms(i: TpmInputs): TpmReading[] {
  const spec = (id: string) => TPM_SPECS.find((s) => s.id === id)!;
  const tick = i.pipeline.stages.find((s) => s.stage === "tick");
  const official = i.sources.filter((s) => OFFICIAL_SOURCES.includes(s.source));
  return [
    evaluate(spec("data_age"), i.pipeline.dataAgeMs === null ? null : i.pipeline.dataAgeMs / 1000, i.pipeline.dataAgeMs === null ? "no measurement yet" : undefined),
    evaluate(spec("loop_liveness"), i.pipeline.lastTickAgeMs === null ? null : i.pipeline.lastTickAgeMs / 1000),
    // A p95 over a handful of ticks is just the cold first tick (all sources fetched at once after a
    // restart): report insufficient until there are enough samples, instead of a false red.
    evaluate(
      spec("tick_p95"),
      tick && tick.samples >= MIN_TICK_SAMPLES ? tick.p95Ms : null,
      tick && tick.samples < MIN_TICK_SAMPLES ? `${tick.samples} ticks; needs ${MIN_TICK_SAMPLES}` : undefined,
    ),
    evaluate(spec("persist_failures"), i.failedWrites),
    evaluate(spec("disk_free"), i.diskFreeBytes === null ? null : i.diskFreeBytes / 1e9),
    evaluate(spec("memory_rss"), i.rssBytes / 1e6),
    evaluate(spec("official_sources_down"), official.length ? official.filter((s) => !s.healthy).length : null),
    evaluate(
      spec("forecast_skill"),
      i.skill.value,
      i.skill.value === null
        ? `${i.skill.samples} resolved forecasts; needs 20`
        : `MAE ${i.skill.maeModel!.toFixed(2)} vs persistence ${i.skill.maePersistence!.toFixed(2)} over ${i.skill.samples}`,
    ),
  ];
}

/** Free bytes on the volume holding `dir`, or null if it cannot be read. */
export async function diskFreeBytes(dir: string): Promise<number | null> {
  try {
    const { statfs } = await import("node:fs/promises");
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
