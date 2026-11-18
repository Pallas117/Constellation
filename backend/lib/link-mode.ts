/**
 * The link guardian's decision, kept pure so it can be tested without pinging anything.
 *
 * One lost ping used to switch the backend to AIRGAP, and in AIRGAP the ingest loop skips every
 * external fetch until the next check 30 s later. On the hotspot that happened 405 times in the
 * live log (4 Nov 2026: 17% of checks read AIRGAP, most of them a single lost ping). Now AIRGAP
 * needs AIRGAP_AFTER failed checks in a row; until then the last mode holds.
 */
export type ConnectivityMode = "CLOUD" | "SAT" | "AIRGAP";

export const AIRGAP_AFTER = 2; // consecutive failed checks (30 s apart) before fetches stop
export const SAT_LATENCY_MS = 150;

export interface LinkState {
  mode: ConnectivityMode;
  latencyMs: number;
  failures: number;
}

/** latencyMs is the ping's round trip, or null when the ping failed. */
export function nextLinkState(prev: LinkState, latencyMs: number | null): LinkState {
  if (latencyMs === null) {
    const failures = prev.failures + 1;
    return failures >= AIRGAP_AFTER
      ? { mode: "AIRGAP", latencyMs: -1, failures }
      : { mode: prev.mode, latencyMs: prev.latencyMs, failures };
  }
  return { mode: latencyMs < SAT_LATENCY_MS ? "CLOUD" : "SAT", latencyMs, failures: 0 };
}
