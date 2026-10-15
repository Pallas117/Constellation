import { useEffect, useRef, useState } from "react";
import { classifyResponse, startPolling, type PollOutcome } from "@/lib/api/feed-poller";
import { useSession } from "@/lib/auth-client";
import { apiBase } from "@/lib/api/base-url";
import { roleOf, type Role } from "@/lib/roles";

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
  /** Consecutive failed attempts; 0 after a success. */
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
  const [failures, setFailures] = useState(0);
  const parseRef = useRef(parse);
  parseRef.current = parse;
  const nextPathRef = useRef(nextPath);
  nextPathRef.current = nextPath;
  const reduceRef = useRef(reduce);
  reduceRef.current = reduce;
  const heldRef = useRef<T | null>(null);

  useEffect(() => {
    if (!path) {
      setStatus(disabledStatus);
      setError(disabledStatus === "sign-in-required" ? signInMessage : null);
      return;
    }
    let mounted = true;
    const base = getBackendBaseUrl();
    // A new route or user starts from nothing, so an incremental feed backfills again.
    heldRef.current = null;

    const poll = async (signal: AbortSignal): Promise<PollOutcome> => {
      const url = `${base}${nextPathRef.current?.(path, heldRef.current) ?? path}`;
      // The backend authenticates by the better-auth session cookie only. Don't
      // call getAuthHeaders() here: it costs a /get-session round trip per poll
      // and better-auth sessions carry no bearer token.
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
      onSchedule: (delay, outcome, consecutive) => {
        if (!mounted) return;
        setFailures(consecutive);
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
  }, [path, intervalMs, maxBackoffMs, disabledStatus, signInMessage, restartKey]);

  return { data, status, loading: status === "waiting", error, failures };
}

/** Signed-in state for choosing which feeds a page may poll. */
export function useFeedSession(): { resolved: boolean; signedIn: boolean; userKey: string; role: Role | null } {
  const { data, isPending } = useSession();
  const user = (data as { user?: { id?: string } } | null | undefined)?.user;
  return { resolved: !isPending, signedIn: Boolean(user), userKey: user?.id ?? "anon", role: user ? roleOf(user) : null };
}
