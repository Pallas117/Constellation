import type { AuroraMapResponse } from "@/lib/types/space-weather";
import { useFeedSession, usePolledFeed, type FeedStatus } from "@/hooks/usePolledFeed";

const POLL_INTERVAL_MS = 5000;
const ENDPOINT = "/api/feed/aurora/map?projection=gsm";

export interface AuroraMapState {
  map: AuroraMapResponse | null;
  loading: boolean;
  error: string | null;
  status: FeedStatus;
}

const parse = (json: unknown) => json as AuroraMapResponse;

export function useAuroraMap(): AuroraMapState {
  // `user`-role route: never request it signed out (CyberTiger counts 401s).
  const session = useFeedSession();
  const feed = usePolledFeed({
    path: session.resolved && session.signedIn ? ENDPOINT : null,
    intervalMs: POLL_INTERVAL_MS,
    parse,
    disabledStatus: session.resolved ? "sign-in-required" : "waiting",
    signInMessage: "Sign in to see the aurora map.",
    restartKey: session.userKey,
  });
  return { map: feed.data, loading: feed.loading, error: feed.error, status: feed.status };
}
