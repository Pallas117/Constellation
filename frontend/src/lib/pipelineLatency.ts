import type { PipelineLatencySnapshot } from "./types/space-weather";

export type PipelineTone = "nominal" | "warn" | "critical" | "unknown";

export interface PipelineView {
  label: string;
  tone: PipelineTone;
  dataAge: string;
  tick: string;
  slowest: string;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "---";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
  return `${Math.floor(ms / 3_600_000)}h${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0")}m`;
}

/**
 * What the HUD shows for the ingest pipeline. It reports the backend's own verdict and the
 * real data age; an unreachable or missing snapshot is "unknown", never assumed fresh.
 * `snapshotAgeMs` is how long ago the snapshot was fetched, added to the reported ages so
 * the display keeps ageing between polls.
 */
export function describePipeline(snapshot: PipelineLatencySnapshot | null, snapshotAgeMs = 0): PipelineView {
  if (!snapshot) {
    return { label: "NO_TELEMETRY", tone: "unknown", dataAge: "---", tick: "---", slowest: "---" };
  }
  const elapsed = Math.max(0, snapshotAgeMs);
  const dataAgeMs = snapshot.dataAgeMs === null ? null : snapshot.dataAgeMs + elapsed;
  const tickAgeMs = snapshot.lastTickAgeMs === null ? null : snapshot.lastTickAgeMs + elapsed;

  // The backend verdict can only get worse while the snapshot ages on the client.
  let status = snapshot.status;
  if (tickAgeMs === null || tickAgeMs > 3 * snapshot.tickIntervalMs) status = "stalled";
  else if (status !== "stalled" && (dataAgeMs === null || dataAgeMs > snapshot.maxAgeMs)) status = "stale";
  else if (status === "fresh" && dataAgeMs !== null && dataAgeMs > snapshot.freshMs) status = "degraded";

  const tone: PipelineTone =
    status === "fresh" ? "nominal" : status === "degraded" ? "warn" : "critical";

  const tickStage = snapshot.stages.find((s) => s.stage === "tick");
  const slowest = snapshot.stages.find((s) => s.stage !== "tick");

  return {
    label: status.toUpperCase(),
    tone,
    dataAge: formatDuration(dataAgeMs),
    tick: tickStage ? `${formatDuration(tickStage.lastMs)} / p95 ${formatDuration(tickStage.p95Ms)}` : "---",
    slowest: slowest
      ? `${slowest.stage.toUpperCase()} ${formatDuration(slowest.lastMs)}${slowest.overBudget ? " !" : ""}`
      : "---",
  };
}
