/**
 * What an operator does next for each trust verdict: one fixed, reviewed line per verdict,
 * shown in the evidence pack PDF and the operator Evidence view (GAU-59).
 *
 * Each line says only what `verdictFor` in backend/trust/record.ts checks:
 * - consistent: radiation and geomagnetic levels below the policy thresholds, required inputs current and unflagged.
 *   Orbit context is not required by the default policy (requireOrbitContext: false), so a pack can say
 *   consistent when the South Atlantic Anomaly was not assessed; the line says so;
 * - degraded-context: a storm level at or above a threshold, inside the South Atlantic Anomaly, or a flagged input;
 * - unknown: a required input missing, too old or conflicting (two sources disagree), or orbit context
 *   unknown when the policy requires it.
 * The verdict judges the conditions an inference ran in, never the output itself. These lines
 * are not part of the hashed pack, so adding or rewording them never changes a pack hash.
 * Plain ASCII: the PDF writer transliterates anything else.
 */
export type VerdictValue = "consistent" | "degraded-context" | "unknown";

export const VERDICT_NEXT_STEP: Record<VerdictValue, string> = {
  consistent:
    "No storm level or flagged input in what Gauss checked: radiation and geomagnetic levels were below your policy thresholds and the required inputs were current and unflagged. Orbit context such as the South Atlantic Anomaly counts only where it was assessed, which your policy may not require; the reasons say when it was not. This judges the conditions, not the output itself.",
  "degraded-context":
    "Give the output a second look before acting on it: compare it with another source for the same time, such as a later pass, a ground re-run or a second model. The reasons name the condition: a storm level at or above your policy threshold, the South Atlantic Anomaly or a flagged input.",
  unknown:
    "Treat the output as not checked by Gauss: a required input was missing, too old or conflicting (two sources disagreed), and the reasons say which. Supply the missing or corrected orbit data, or run the replay again once current space-weather data is available.",
};

/** Verdict words as people read them ("degraded context", not "degraded-context"). */
export const VERDICT_LABEL: Record<VerdictValue, string> = {
  consistent: "consistent",
  "degraded-context": "degraded context",
  unknown: "unknown",
};

export const VERDICT_ORDER: readonly VerdictValue[] = ["degraded-context", "unknown", "consistent"];
