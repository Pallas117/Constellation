import { useEffect, useState } from "react";
import { authClient, passkeyCredentialOf, useSession } from "@/lib/auth-client";
import { geometryForPublicKey, type OperatorGeometry } from "@/lib/operator-geometry";

/** A passkey as better-auth lists it (public data only). */
export interface PasskeyRow {
  id: string;
  name?: string | null;
  publicKey: string;
  credentialID: string;
  deviceType?: string;
  backedUp?: boolean;
  createdAt?: string | Date | null;
}

interface GeometryState {
  passkeys: PasskeyRow[] | null;
  geometry: OperatorGeometry | null;
  /** The passkey the geometry comes from: this session's, else the newest. */
  credentialId: string | null;
}

const EMPTY: GeometryState = { passkeys: null, geometry: null, credentialId: null };

// One list request per session and refresh, shared by the header and the account page.
const cache = new Map<string, Promise<GeometryState>>();
let generation = 0;
const listeners = new Set<(generation: number) => void>();

/** Re-read passkeys everywhere (after adding or removing one). */
export function refreshOperatorGeometry(): void {
  cache.clear();
  generation += 1;
  for (const listener of listeners) listener(generation);
}

async function load(sessionCredential: string | null): Promise<GeometryState> {
  const { data, error } = await authClient.passkey.listUserPasskeys();
  if (error) throw new Error(error.message ?? "Could not list passkeys");
  const passkeys = ((data ?? []) as PasskeyRow[]).slice().sort((a, b) => Date.parse(String(b.createdAt ?? 0)) - Date.parse(String(a.createdAt ?? 0)));
  const chosen = passkeys.find((p) => p.credentialID === sessionCredential) ?? passkeys[0];
  return {
    passkeys,
    geometry: chosen ? await geometryForPublicKey(chosen.publicKey) : null,
    credentialId: chosen?.credentialID ?? null,
  };
}

/**
 * The signed-in operator's passkeys and geometry. Lists passkeys only while
 * signed in (an auth route, never a CyberTiger-counted one).
 */
export function useOperatorGeometry(): GeometryState {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const sessionCredential = passkeyCredentialOf(session?.session);
  // Tagged with the user it was loaded for, so a previous account's figure never shows.
  const [state, setState] = useState<GeometryState & { userId: string | null }>({ ...EMPTY, userId: null });
  const [version, setVersion] = useState(generation);

  useEffect(() => {
    listeners.add(setVersion);
    return () => {
      listeners.delete(setVersion);
    };
  }, []);

  useEffect(() => {
    if (!userId) return;
    const key = `${userId}|${sessionCredential ?? ""}|${version}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = load(sessionCredential);
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    let cancelled = false;
    pending.then(
      (next) => !cancelled && setState({ ...next, userId }),
      () => !cancelled && setState({ ...EMPTY, passkeys: [], userId }),
    );
    return () => {
      cancelled = true;
    };
  }, [userId, sessionCredential, version]);

  return userId && state.userId === userId ? state : EMPTY;
}
