import { useSession } from "@/lib/auth-client";
import { hasRole, roleOf } from "@/lib/roles";
import type { L1StructuresResponse } from "@/lib/types/l1-structures";
import { usePolledFeed } from "@/hooks/usePolledFeed";

const ENDPOINT = "/api/swx/structures";
const POLL_INTERVAL_MS = 60_000; // the backend recomputes on each 1-minute RTSW fetch

const parse = (json: unknown) => json as L1StructuresResponse;

/** L1 structure candidates for the operator console (GAU-154). */
export function useL1Structures() {
  const { data, isPending } = useSession();
  const user = (data as { user?: { id?: string } } | null | undefined)?.user;
  // `operator` route: never request it without that role (CyberTiger counts 401s and 403s).
  const operator = !isPending && Boolean(user) && hasRole(roleOf(user), "operator");
  return usePolledFeed({ path: operator ? ENDPOINT : null, intervalMs: POLL_INTERVAL_MS, parse, restartKey: user?.id ?? "anon" });
}
