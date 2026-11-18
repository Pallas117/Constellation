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

/** How long one link check waits for its ping reply. */
export const PING_TIMEOUT_MS = 2000;

/**
 * The ping for one link check. `-W` is in milliseconds on macOS and the BSDs but in seconds on
 * Linux (iputils), so the same "-W 2000" waited up to 2000 s (33 min) on Linux. Every gate run on
 * Talos stalled there on 18 Nov 2026: a test imports the backend, the link guardian pings on start,
 * and the gate sandbox gets no ICMP reply. connectivity.ts also kills the child after a second more.
 */
export function pingCommand(host: string, platform: NodeJS.Platform = process.platform): string {
  const bsd = platform === "darwin" || platform === "freebsd" || platform === "openbsd" || platform === "netbsd";
  const wait = bsd ? PING_TIMEOUT_MS : Math.ceil(PING_TIMEOUT_MS / 1000);
  return `ping -c 1 -W ${wait} ${host}`;
}
