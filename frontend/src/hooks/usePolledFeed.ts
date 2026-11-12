import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { classifyResponse, startPolling, type PollOutcome } from "@/lib/api/feed-poller";
import { useSession } from "@/lib/auth-client";
import { apiBase } from "@/lib/api/base-url";

export function getBackendBaseUrl(): string {
  return apiBase();
}

export type FeedStatus =
  | "waiting" // session not resolved yet, nothing requested
  | "live"
  | "backing-off" // last attempt failed; retrying with backoff
  | "sign-in-required"; // route needs an account; not polled

export interface PolledFeed<T> {
  data: T | null;
  status: FeedStatus;
  loading: boolean;
  error: string | null;
  /** Consecutive failed polls since the last success (0 while healthy). */
  failures: number;
}

export interface PolledFeedOptions<T> {
  /** Backend path; `null` disables polling (e.g. signed out on an auth-only route). */
  path: string | null;
  intervalMs: number;
  maxBackoffMs?: number;
  parse: (json: unknown) => T;
  /** Status to report while `path` is null. */
  disabledStatus?: Extract<FeedStatus, "waiting" | "sign-in-required">;
  /** Message to show while `path` is null and sign-in is required. */
  signInMessage?: string;
  /** Changing this restarts polling (e.g. the signed-in user id). */
  restartKey?: string;
  /** Path for each request given the data held so far, e.g. to ask only for newer points. */
  nextPath?: (path: string, held: T | null) => string;
  /** Combine held data with a response; returning `held` itself skips the re-render. */
  reduce?: (held: T | null, next: T) => T;
}

/** Poll a Gauss backend feed with backoff; see lib/api/feed-poller.ts. */
/**
 * Which polling run a failure count belongs to: a new route or restartKey starts a new run at zero.
 * Kept with the count, so the count resets without a setState inside the effect (react-hooks lint).
 */
const runKeyOf = (path: string | null | undefined, restartKey: string | undefined) => `${path ?? ""}\u0000${restartKey ?? ""}`;

export function usePolledFeed<T>({
  path,
  intervalMs,
  maxBackoffMs = 5 * 60_000,
  parse,
  disabledStatus = "waiting",
  signInMessage = "Sign in to see this feed.",
  restartKey,
  nextPath,
  reduce,
}: PolledFeedOptions<T>): PolledFeed<T> {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<FeedStatus>("waiting");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ run: string; n: number }>({ run: "", n: 0 });
  const parseRef = useRef(parse);
  const nextPathRef = useRef(nextPath);
  const reduceRef = useRef(reduce);
  // Layout effects run before the polling effect below, so a poll never sees stale callbacks.
  useLayoutEffect(() => {
    parseRef.current = parse;
    nextPathRef.current = nextPath;
    reduceRef.current = reduce;
  });
  const heldRef = useRef<T | null>(null);

  useEffect(() => {
    if (!path) return;
    let mounted = true;
    const base = getBackendBaseUrl();
    // A new route or user starts from nothing, so an incremental feed backfills again.
    heldRef.current = null;
    const run = runKeyOf(path, restartKey);

    const poll = async (signal: AbortSignal): Promise<PollOutcome> => {
      const url = `${base}${nextPathRef.current?.(path, heldRef.current) ?? path}`;
      // The backend authenticates by the better-auth session cookie only; better-auth
      // sessions carry no bearer token, so there is no Authorization header to add.
      const response = await fetch(url, { signal, credentials: "include" });
      const outcome = classifyResponse(response);
      if (outcome.kind === "ok" && mounted) {
        const parsed = parseRef.current(await response.json());
        const combine = reduceRef.current;
        heldRef.current = combine ? combine(heldRef.current, parsed) : parsed;
        setData(heldRef.current);
        setStatus("live");
        setError(null);
      }
      return outcome;
    };

    const stop = startPolling({
      poll,
      policy: { baseMs: intervalMs, maxMs: maxBackoffMs },
      onSchedule: (delay, outcome) => {
        if (!mounted) return;
        setFailed((prev) => ({ run, n: outcome.kind === "ok" ? 0 : (prev.run === run ? prev.n : 0) + 1 }));
        if (outcome.kind === "ok" || delay === null) return;
        setStatus("backing-off");
        setError(
          outcome.kind === "rate-limited"
            ? `Rate limited; retrying in ${Math.round(delay / 1000)} s`
            : outcome.kind === "error" && outcome.status
              ? `Feed HTTP ${outcome.status}; retrying in ${Math.round(delay / 1000)} s`
              : `Feed unreachable; retrying in ${Math.round(delay / 1000)} s`,
        );
      },
      onUnauthorized: () => {
        if (!mounted) return;
        setStatus("sign-in-required");
        setError(signInMessage);
      },
    });

    return () => {
      mounted = false;
      stop();
    };
  }, [path, intervalMs, maxBackoffMs, signInMessage, restartKey]);

  // With no path nothing is polled, so the status comes from the options, not the last poll.
  if (!path) {
    return {
      data,
      status: disabledStatus,
      loading: disabledStatus === "waiting",
      error: disabledStatus === "sign-in-required" ? signInMessage : null,
      failures: 0,
    };
  }
  const failures = failed.run === runKeyOf(path, restartKey) ? failed.n : 0;
  return { data, status, loading: status === "waiting", error, failures };
}

/** Signed-in state for choosing which feeds a page may poll. */
export function useFeedSession(): { resolved: boolean; signedIn: boolean; userKey: string } {
  const { data, isPending } = useSession();
  const user = (data as { user?: { id?: string } } | null | undefined)?.user;
  return { resolved: !isPending, signedIn: Boolean(user), userKey: user?.id ?? "anon" };
}
