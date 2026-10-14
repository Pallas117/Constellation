import type { PipelineLatencySnapshot, PipelineStageLatency } from "../types.js";

// Per-stage latency budgets. A stage over budget is reported, never hidden; a fetch that
// exceeds its timeout is abandoned so one slow source cannot hold back the whole tick.
export const STAGE_BUDGET_MS: Record<string, number> = {
  noaa: 8_000,
  esa: 8_000,
  goes: 8_000,
  "kyoto-dst": 8_000,
  jaxa: 8_000,
  mms: 9_000,
  lasp: 9_000,
  "ml-forecast": 5_000,
  nowcast: 250,
  "aurora-grid": 1_000,
  persist: 1_000,
  tick: 5_000,
};

const WINDOW = 60;

export class StageTimeoutError extends Error {
  constructor(stage: string, ms: number) {
    super(`${stage} exceeded its ${ms}ms budget`);
    this.name = "StageTimeoutError";
  }
}

interface StageRecord {
  durations: number[];
  errors: number;
  timeouts: number;
  lastAt: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Rolling per-stage timings for the ingest pipeline (last WINDOW samples per stage). */
export class PipelineTimer {
  private stages = new Map<string, StageRecord>();
  private ticks = 0;
  private skippedTicks = 0;
  private lastTickStartedAt: number | null = null;
  private lastTickFinishedAt: number | null = null;

  constructor(private now: () => number = () => Date.now()) {}

  record(stage: string, durationMs: number, outcome: "ok" | "error" | "timeout" = "ok"): void {
    const rec = this.stages.get(stage) ?? { durations: [], errors: 0, timeouts: 0, lastAt: 0 };
    rec.durations.push(durationMs);
    if (rec.durations.length > WINDOW) rec.durations.shift();
    if (outcome === "error") rec.errors += 1;
    if (outcome === "timeout") rec.timeouts += 1;
    rec.lastAt = this.now();
    this.stages.set(stage, rec);
  }

  /**
   * Time `fn` as `stage`. With `timeoutMs`, the stage is abandoned (rejects with
   * StageTimeoutError) once the budget is spent; the caller keeps its previous value.
   */
  async time<T>(stage: string, fn: () => Promise<T> | T, timeoutMs?: number): Promise<T> {
    const start = this.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = Promise.resolve().then(fn);
      const result = timeoutMs
        ? await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new StageTimeoutError(stage, timeoutMs)), timeoutMs);
            }),
          ])
        : await work;
      this.record(stage, this.now() - start, "ok");
      return result;
    } catch (error) {
      this.record(stage, this.now() - start, error instanceof StageTimeoutError ? "timeout" : "error");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  tickStarted(): void {
    this.lastTickStartedAt = this.now();
  }

  tickFinished(): void {
    const end = this.now();
    if (this.lastTickStartedAt !== null) this.record("tick", end - this.lastTickStartedAt, "ok");
    this.lastTickFinishedAt = end;
    this.ticks += 1;
  }

  tickSkipped(): void {
    this.skippedTicks += 1;
  }

  /**
   * @param dataTimestamp timestamp of the newest real measurement feeding the nowcast
   * @param freshMs / maxAgeMs the data-age thresholds (live / expired)
   */
  snapshot(
    tickIntervalMs: number,
    dataTimestamp: string | null,
    freshMs: number,
    maxAgeMs: number,
  ): PipelineLatencySnapshot {
    const now = this.now();
    const dataT = dataTimestamp ? Date.parse(dataTimestamp) : NaN;
    const dataAgeMs = Number.isFinite(dataT) ? Math.max(0, now - dataT) : null;
    const lastTickAgeMs = this.lastTickFinishedAt === null ? null : now - this.lastTickFinishedAt;

    const stages: PipelineStageLatency[] = [...this.stages.entries()].map(([stage, rec]) => {
      const sorted = [...rec.durations].sort((a, b) => a - b);
      const lastMs = rec.durations[rec.durations.length - 1] ?? 0;
      const budgetMs = STAGE_BUDGET_MS[stage] ?? null;
      return {
        stage,
        lastMs,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        maxMs: sorted[sorted.length - 1] ?? 0,
        budgetMs,
        overBudget: budgetMs !== null && lastMs > budgetMs,
        samples: rec.durations.length,
        errors: rec.errors,
        timeouts: rec.timeouts,
        lastAt: new Date(rec.lastAt).toISOString(),
      };
    });

    // A stalled loop is worse than old data: nothing new can arrive until it recovers.
    const stalled = lastTickAgeMs === null || lastTickAgeMs > 3 * tickIntervalMs;
    let status: PipelineLatencySnapshot["status"];
    if (stalled) status = "stalled";
    else if (dataAgeMs === null || dataAgeMs > maxAgeMs) status = "stale";
    else if (dataAgeMs > freshMs || stages.some((s) => s.overBudget)) status = "degraded";
    else status = "fresh";

    return {
      generatedAt: new Date(now).toISOString(),
      status,
      tickIntervalMs,
      ticks: this.ticks,
      skippedTicks: this.skippedTicks,
      lastTickAt: this.lastTickFinishedAt === null ? null : new Date(this.lastTickFinishedAt).toISOString(),
      lastTickAgeMs,
      dataTimestamp: Number.isFinite(dataT) ? new Date(dataT).toISOString() : null,
      dataAgeMs,
      freshMs,
      maxAgeMs,
      stages: stages.sort((a, b) => b.lastMs - a.lastMs),
    };
  }
}
