import type { SpaceObjectDetectionAlert } from "./types/space-object";

export interface SsaStatus {
  state: "unknown" | "alert";
  /** Short header line, e.g. for the nav. */
  label: string;
  /** One-line explanation for the SSA panel. */
  detail: string;
}

/**
 * What the SSA displays may claim. No detection source is connected yet (GAU-89), so the absence
 * of an alert means nothing was looked for, not that nothing is there: it is unknown, never
 * "nominal" or "all assets accounted for" (GAU-81 / GAU-63).
 */
export function ssaStatus(alert: SpaceObjectDetectionAlert | null | undefined): SsaStatus {
  if (alert) {
    return {
      state: "alert",
      label: `UNTRACKED OBJECTS DETECTED: ${alert.candidateCount}`,
      detail: alert.description,
    };
  }
  return {
    state: "unknown",
    label: "SSA: UNKNOWN // NO_DETECTOR",
    detail: "No detection source connected: untracked objects cannot be ruled out.",
  };
}
