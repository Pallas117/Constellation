// Server-side idle sign-out for operator and admin sessions (threat model TM-04, TM-12).
//
// better-auth's own expiry is sliding (12 h without use, see backend/better-auth.ts). Operator and admin powers get a
// shorter leash: a session that makes no request for `idleMs` (30 min) is ended on the server, so a laptop left
// open, or a copied cookie used later, stops working without relying on the browser to sign itself out.
//
// - Activity is the last request the backend saw for that session, kept in memory by a hash of the session token.
//   A restart forgets it, and the first request after a restart starts the clock again (stated, not hidden).
// - A session ended here is remembered for `endedTtlMs`, so the 401s an open dashboard sends with that dead cookie
//   are recognised as "we signed you out", not as someone guessing, and CyberTiger doesn't block the operator's
//   own address when they come back (CLAUDE.md: never let the UI poll into a CyberTiger block).
// - Both maps are bounded (oldest dropped first) so they can't grow without limit (the FM-15 lesson).
import { createHash } from "node:crypto";

export interface IdleOptions {
  idleMs: number;
  endedTtlMs: number;
  maxTracked: number;
  now: () => number;
}

const DEFAULTS: IdleOptions = { idleMs: 30 * 60_000, endedTtlMs: 2 * 60 * 60_000, maxTracked: 10_000, now: Date.now };

export const tokenKey = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The session token in a better-auth session cookie (`<token>.<signature>`, URL-encoded), or null. */
export function sessionTokenFromCookie(cookieHeader: string | null | undefined): string | null {
  const match = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/.exec(cookieHeader ?? "");
  if (!match) return null;
  let value: string;
  try {
    value = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const token = value.split(".")[0];
  return token ? token : null;
}

export class SessionIdle {
  private readonly opts: IdleOptions;
  private readonly lastSeen = new Map<string, number>();
  private readonly ended = new Map<string, number>();

  constructor(options: Partial<IdleOptions> = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  get idleMinutes(): number {
    return Math.round(this.opts.idleMs / 60_000);
  }

  /** Records a request for this session; returns "idle" if it had gone quiet for longer than the idle limit. */
  touch(token: string): "ok" | "idle" {
    const key = tokenKey(token);
    const now = this.opts.now();
    const last = this.lastSeen.get(key);
    if (last !== undefined && now - last > this.opts.idleMs) return "idle";
    this.lastSeen.delete(key); // re-insert so the map stays in last-use order for eviction
    this.bounded(this.lastSeen, key, now);
    return "ok";
  }

  /** Marks a session as ended by this server (idle, or any other server-side sign-out). */
  end(token: string): void {
    const key = tokenKey(token);
    this.lastSeen.delete(key);
    this.bounded(this.ended, key, this.opts.now());
  }

  /** Whether this server ended that session within the last `endedTtlMs`. */
  wasEnded(token: string | null | undefined): boolean {
    if (!token) return false;
    const key = tokenKey(token);
    const at = this.ended.get(key);
    if (at === undefined) return false;
    if (this.opts.now() - at > this.opts.endedTtlMs) {
      this.ended.delete(key);
      return false;
    }
    return true;
  }

  get size(): { active: number; ended: number } {
    return { active: this.lastSeen.size, ended: this.ended.size };
  }

  private bounded(map: Map<string, number>, key: string, value: number): void {
    if (!map.has(key) && map.size >= this.opts.maxTracked) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
  }
}
