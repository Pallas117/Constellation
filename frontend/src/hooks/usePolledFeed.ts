import { useEffect, useRef, useState } from "react";
import { classifyResponse, startPolling, type PollOutcome } from "@/lib/api/feed-poller";
import { useSession } from "@/lib/auth-client";

export function getBackendBaseUrl(): string {
  return import.meta.env.VITE_HELIO_PROXY_URL ?? "http://127.0.0.1:3001";
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
}: PolledFeedOptions<T>): PolledFeed<T> {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<FeedStatus>("waiting");
  const [error, setError] = useState<string | null>(null);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  useEffect(() => {
    if (!path) {
      setStatus(disabledStatus);
      setError(disabledStatus === "sign-in-required" ? signInMessage : null);
      return;
    }
    let mounted = true;
    const url = `${getBackendBaseUrl()}${path}`;

    const poll = async (signal: AbortSignal): Promise<PollOutcome> => {
      // The backend authenticates by the better-auth session cookie only. Don't
      // call getAuthHeaders() here: it costs a /get-session round trip per poll
      // and better-auth sessions carry no bearer token.
      const response = await fetch(url, { signal, credentials: "include" });
      const outcome = classifyResponse(response);
      if (outcome.kind === "ok" && mounted) {
        setData(parseRef.current(await response.json()));
        setStatus("live");
        setError(null);
      }
      return outcome;
    };

    const stop = startPolling({
      poll,
      policy: { baseMs: intervalMs, maxMs: maxBackoffMs },
      onSchedule: (delay, outcome) => {
        if (!mounted || outcome.kind === "ok" || delay === null) return;
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

  return { data, status, loading: status === "waiting", error };
}

/** Signed-in state for choosing which feeds a page may poll. */
export function useFeedSession(): { resolved: boolean; signedIn: boolean; userKey: string } {
  const { data, isPending } = useSession();
  const user = (data as { user?: { id?: string } } | null | undefined)?.user;
  return { resolved: !isPending, signedIn: Boolean(user), userKey: user?.id ?? "anon" };
}
