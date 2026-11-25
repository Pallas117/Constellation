/**
 * Argo session ratchet: server-side state (see ratchet.ts and docs/security/argo-session-ratchet.md).
 * Off unless ARGO_SESSION_RATCHET=on, and not mounted on any route yet: wiring it into backend/server.ts
 * (root route in API_POLICY, a per-request guard after enforceApiPolicy) is a later change Josh merges.
 *
 * State is in memory only: a restart ends every ratchet. Nothing here is written to disk or logs
 * (no key material, no tags, no cookie tokens: the store keeps a SHA-256 of the token only).
 */
import { createHash } from "node:crypto";
import { MAX_SKIP, TAG_BYTES, ackTag, b64u, contextDigest, fromB64u, messageKey, nextChainKey, requestTag, tagsEqual, type DeviceFacts } from "./ratchet.ts";

export function argoSessionRatchetEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ARGO_SESSION_RATCHET ?? "").trim().toLowerCase() === "on";
}

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("base64url");

/** x-argo-session: <handle>.<step>.<tag>; handle base64url 16-64 chars, step 0-999999999, tag 32 bytes base64url. */
const HEADER = /^([A-Za-z0-9_-]{16,64})\.(\d{1,9})\.([A-Za-z0-9_-]{43})$/;

export function parseStepHeader(value: string | undefined | null): { handle: string; step: number; tag: Buffer } | null {
  const m = HEADER.exec(value ?? "");
  if (!m) return null;
  const tag = fromB64u(m[3]);
  return tag.length === TAG_BYTES ? { handle: m[1], step: Number(m[2]), tag } : null;
}

interface State {
  handle: string;
  userId: string;
  tokenHash: string;
  device: DeviceFacts;
  next: number;
  ck: Buffer;
  skipped: Map<number, Buffer>;
  createdAt: number;
  lastUsed: number;
}

export type StepFailure = "no-session" | "malformed" | "other-session" | "device-changed" | "replay" | "too-far" | "bad-tag";
export type StepResult = { ok: true; ack: string } | { ok: false; reason: StepFailure; userId?: string };

export interface SessionStoreOptions {
  now?: () => number;
  /** Idle limit, ms (default 30 min). */
  idleMs?: number;
  /** Absolute lifetime from the root, ms (default 12 h). */
  maxAgeMs?: number;
  /** Ratchets per user (default 4); the oldest goes first. */
  maxPerUser?: number;
  /** Ratchets in total (default 5000); the oldest goes first. */
  maxTotal?: number;
}

export function createSessionStore(options: SessionStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? 30 * 60_000;
  const maxAgeMs = options.maxAgeMs ?? 12 * 60 * 60_000;
  const maxPerUser = options.maxPerUser ?? 4;
  const maxTotal = options.maxTotal ?? 5_000;
  const states = new Map<string, State>();

  const wipe = (s: State) => {
    s.ck.fill(0);
    for (const k of s.skipped.values()) k.fill(0);
    s.skipped.clear();
    states.delete(s.handle);
  };
  const expired = (s: State) => now() - s.lastUsed > idleMs || now() - s.createdAt > maxAgeMs;
  const live = (handle: string): State | undefined => {
    const s = states.get(handle);
    if (s && expired(s)) {
      wipe(s);
      return undefined;
    }
    return s;
  };
  const sweep = () => {
    for (const s of [...states.values()]) if (expired(s)) wipe(s);
  };

  return {
    size: () => states.size,
    has: (handle: string) => live(handle) !== undefined,
    sweep,
    /** A new ratchet replaces any other on the same cookie session, and the user's oldest past the cap. */
    add(input: { handle: string; userId: string; token: string; device: DeviceFacts; chainKey: Buffer }): void {
      sweep();
      const th = tokenHash(input.token);
      for (const s of [...states.values()]) if (s.tokenHash === th || s.handle === input.handle) wipe(s);
      const mine = [...states.values()].filter((s) => s.userId === input.userId).sort((a, b) => a.lastUsed - b.lastUsed);
      while (mine.length >= maxPerUser) wipe(mine.shift() as State);
      while (states.size >= maxTotal) wipe(states.values().next().value as State);
      const t = now();
      states.set(input.handle, {
        handle: input.handle,
        userId: input.userId,
        tokenHash: th,
        device: { ip: input.device.ip },
        next: 0,
        ck: input.chainKey,
        skipped: new Map(),
        createdAt: t,
        lastUsed: t,
      });
    },
    /** Sign-out, cookie revocation, and (TODO duress) a duress sign-in: ends the ratchets on this cookie session. */
    killToken(token: string): string[] {
      const th = tokenHash(token);
      const gone = [...states.values()].filter((s) => s.tokenHash === th);
      gone.forEach(wipe);
      return gone.map((s) => s.handle);
    },
    /** Admin revocation, role change or account removal: ends every ratchet of the user. */
    killUser(userId: string): string[] {
      const gone = [...states.values()].filter((s) => s.userId === userId);
      gone.forEach(wipe);
      return gone.map((s) => s.handle);
    },
    /**
     * One request. Any failure on a live ratchet deletes it: a wrong tag (wrong key, context, method,
     * path or step), a replayed or too-far step, another cookie session, or another client address.
     */
    step(input: { handle: string; step: number; tag: Uint8Array; token: string; device: DeviceFacts; net: string | null; method: string; path: string }): StepResult {
      const s = live(input.handle);
      if (!s) return { ok: false, reason: "no-session" };
      const fail = (reason: StepFailure): StepResult => {
        wipe(s);
        return { ok: false, reason, userId: s.userId };
      };
      if (!Number.isSafeInteger(input.step) || input.step < 0 || input.tag.length !== TAG_BYTES) return fail("malformed");
      if (!tagsEqual(Buffer.from(s.tokenHash), Buffer.from(tokenHash(input.token)))) return fail("other-session");
      if (s.device.ip !== input.device.ip) return fail("device-changed");
      let ck: Buffer | undefined;
      if (input.step < s.next) {
        ck = s.skipped.get(input.step);
        if (!ck) return fail("replay");
        s.skipped.delete(input.step);
      } else {
        if (input.step - s.next >= MAX_SKIP) return fail("too-far");
        while (s.next < input.step) {
          s.skipped.set(s.next, s.ck);
          s.ck = nextChainKey(s.ck);
          s.next += 1;
        }
        ck = s.ck;
        s.ck = nextChainKey(s.ck);
        s.next += 1;
        while (s.skipped.size > MAX_SKIP) {
          const oldest = s.skipped.keys().next().value as number;
          s.skipped.get(oldest)?.fill(0);
          s.skipped.delete(oldest);
        }
      }
      const mk = messageKey(ck, contextDigest({ net: input.net }));
      ck.fill(0);
      if (!tagsEqual(requestTag(mk, input.step, input.method, input.path), input.tag)) {
        mk.fill(0);
        return fail("bad-tag");
      }
      s.lastUsed = now();
      const ack = `${input.step}.${b64u(ackTag(mk, input.step))}`;
      mk.fill(0);
      return { ok: true, ack };
    },
    /** Test hook: how many skipped chain keys the ratchet still holds (forward-secrecy check). */
    skippedCount: (handle: string): number => states.get(handle)?.skipped.size ?? 0,
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
