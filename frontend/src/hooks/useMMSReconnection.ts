import { useMemo } from "react";
import type { MMSReconVectorPoint } from "@/lib/types/space-weather";
import { useFeedSession, usePolledFeed, type FeedStatus } from "@/hooks/usePolledFeed";

const POLL_INTERVAL_MS = 5000;
const ENDPOINT = "/api/feed/mms/reconnection?lookback=PT2H&limit=1440";

export interface MMSReconnectionState {
  vectors: MMSReconVectorPoint[];
  latest: MMSReconVectorPoint | null;
  loading: boolean;
  error: string | null;
  status: FeedStatus;
}

const EMPTY: MMSReconVectorPoint[] = [];

const parse = (json: unknown) => {
  const vectors = (json as { vectors?: MMSReconVectorPoint[] } | null)?.vectors;
  return Array.isArray(vectors) ? vectors : [];
};

export function useMMSReconnection(): MMSReconnectionState {
  // `user`-role route: never request it signed out (CyberTiger counts 401s).
  const session = useFeedSession();
  const feed = usePolledFeed({
    path: session.resolved && session.signedIn ? ENDPOINT : null,
    intervalMs: POLL_INTERVAL_MS,
    parse,
    disabledStatus: session.resolved ? "sign-in-required" : "waiting",
    signInMessage: "Sign in to see MMS reconnection vectors.",
    restartKey: session.userKey,
  });
  const vectors = feed.data ?? EMPTY;

  return {
    vectors,
    latest: useMemo(() => (vectors.length > 0 ? vectors[vectors.length - 1] : null), [vectors]),
    loading: feed.loading,
    error: feed.error,
    status: feed.status,
  };
}
