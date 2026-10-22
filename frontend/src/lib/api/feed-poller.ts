// Polling for Gauss backend feeds that can't get an IP blocked.
//
// CyberTiger counts 401/403 responses and auto-blocks the caller's IP, and the
// backend rate-limits with 429. So:
// - 401/403 stops polling until the session changes (retrying can't fix it);
// - 429 backs off exponentially, honouring Retry-After;
// - network errors, 404 and 5xx back off exponentially;
// - success returns to the base interval;
// - one request at a time (setTimeout chain, never setInterval);
// - nothing is fetched while the tab is hidden.

export type PollOutcome =
  | { kind: "ok" }
  | { kind: "unauthorized"; status: number }
  | { kind: "rate-limited"; retryAfterMs?: number }
  | { kind: "error"; status?: number };

export interface BackoffPolicy {
  /** Delay after a success. */
  baseMs: number;
  /** Ceiling for any backoff delay. */
  maxMs: number;
}

export function classifyResponse(response: Pick<Response, "ok" | "status" | "headers">, now = Date.now()): PollOutcome {
  if (response.ok) return { kind: "ok" };
  if (response.status === 401 || response.status === 403) return { kind: "unauthorized", status: response.status };
  if (response.status === 429) {
    return { kind: "rate-limited", retryAfterMs: parseRetryAfter(response.headers.get("Retry-After"), now) };
  }
  return { kind: "error", status: response.status };
}

/** Retry-After as delta-seconds or an HTTP date; undefined if absent or invalid. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * Delay before the next poll, or null to stop.
 * `failures` counts consecutive failures including this one.
 * Backoff gets ±20% jitter so many tabs don't retry in lockstep.
 */
export function nextDelay(outcome: PollOutcome, failures: number, policy: BackoffPolicy, random: () => number = Math.random): number | null {
  if (outcome.kind === "ok") return policy.baseMs;
  if (outcome.kind === "unauthorized") return null;
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, failures));
  const jittered = Math.round(exp * (0.8 + 0.4 * random()));
  if (outcome.kind === "rate-limited" && outcome.retryAfterMs !== undefined) {
    return Math.min(policy.maxMs, Math.max(outcome.retryAfterMs, jittered));
  }
  return Math.min(policy.maxMs, jittered);
}

export interface PollerOptions {
  /** One request; resolve to its outcome. Must not throw for HTTP errors. */
  poll: (signal: AbortSignal) => Promise<PollOutcome>;
  policy: BackoffPolicy;
  /** Called once when polling stops because of 401/403. */
  onUnauthorized?: (status: number) => void;
  /** Called after every attempt with the scheduled delay (null = stopped). */
  onSchedule?: (delayMs: number | null, outcome: PollOutcome) => void;
  random?: () => number;
}

/** Start polling immediately; returns a stop function. */
export function startPolling(options: PollerOptions): () => void {
  const { poll, policy, onUnauthorized, onSchedule, random } = options;
  const doc: Document | undefined = typeof document === "undefined" ? undefined : document;
  let stopped = false;
  let inFlight = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let dueWhileHidden = false;

  const schedule = (delay: number) => {
    timer = setTimeout(tick, delay);
  };

  const tick = async () => {
    timer = undefined;
    if (stopped || inFlight) return;
    if (doc?.hidden) {
      dueWhileHidden = true;
      return;
    }
    inFlight = true;
    controller = new AbortController();
    let outcome: PollOutcome;
    try {
      outcome = await poll(controller.signal);
    } catch {
      outcome = { kind: "error" };
    }
    inFlight = false;
    if (stopped) return;

    failures = outcome.kind === "ok" ? 0 : failures + 1;
    const delay = nextDelay(outcome, failures, policy, random);
    onSchedule?.(delay, outcome);
    if (delay === null) {
      stopped = true;
      if (outcome.kind === "unauthorized") onUnauthorized?.(outcome.status);
      return;
    }
    schedule(delay);
  };

  const onVisibility = () => {
    if (!doc?.hidden && dueWhileHidden && !stopped) {
      dueWhileHidden = false;
      void tick();
    }
  };
  doc?.addEventListener("visibilitychange", onVisibility);

  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
    doc?.removeEventListener("visibilitychange", onVisibility);
  };
}
