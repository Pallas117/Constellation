/**
 * Operator patterns (GAU-235): a path an operator draws through the 16 vertices of their
 * rotating tesseract, checked at sign-in on top of the passkey. Same rules as the signing-key
 * pattern lock (backend/trust/key-lock.ts): 8 to 24 vertices, at least 6 different.
 *
 * A pattern holds at most about 31 bits of choice, fewer as people pick them, so it is a second
 * check, not a strong secret on its own. Two things keep it from being guessed:
 * - online, five misses lock the pattern for 15 minutes (per operator, wherever the tries come
 *   from), and the routes are rate-limited per address;
 * - offline, the stored value is scrypt over an HMAC keyed with a pepper derived from the auth
 *   secret, so a copy of the auth database alone can't be searched. Rotating the auth secret
 *   signs everyone out and makes operators draw a new pattern.
 * The pattern itself is never stored or logged.
 */
import { createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { FIGURE, patternProblem } from "../trust/key-lock.js";

export { PATTERN_RULES, patternProblem, VERTEX_LABELS, VERTICES } from "../trust/key-lock.js";

export const PATTERN_MAX_MISSES = 5;
export const PATTERN_LOCK_MS = 15 * 60_000;
/** One-time phone requests (the Mac shows a QR code, the phone draws). */
export const PAD_REQUEST_TTL_MS = 2 * 60_000;
export const PAD_REQUEST_MAX_TRIES = 5;

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}
/** About 0.1 s and 32 MiB per check on an M1: sign-ins are rare, guesses are capped by the lockout. */
export const PATTERN_SCRYPT: ScryptCost = { N: 2 ** 15, r: 8, p: 1 };

const scryptAsync = (secret: Buffer, salt: Buffer, cost: ScryptCost) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(secret, salt, 32, { ...cost, maxmem: 128 * cost.N * cost.r * cost.p + 32 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** At most `max` scrypt runs at once, so a burst of checks can't take hundreds of MiB. */
function oneAtATime(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** The pepper for pattern hashes, derived from the auth secret (never the secret itself). */
export function patternPepper(authSecret: string): Buffer {
  if (!authSecret) throw new Error("an auth secret is needed to protect operator patterns");
  return Buffer.from(hkdfSync("sha256", authSecret, "gauss-operator-pattern", "v1", 32));
}

export type PatternCheck =
  | { ok: true }
  | { ok: false; reason: "not-set" }
  | { ok: false; reason: "locked"; lockedUntil: number }
  | { ok: false; reason: "miss"; triesLeft: number; lockedUntil: number | null };

interface Row {
  userId: string;
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
  misses: number;
  lockedUntil: number | null;
}

export interface PatternStore {
  isSet(userId: string): boolean;
  lockedUntil(userId: string): number | null;
  /** Sets (or replaces) the operator's pattern. Throws with the rule it breaks. */
  set(userId: string, pattern: readonly number[]): Promise<void>;
  check(userId: string, pattern: readonly number[]): Promise<PatternCheck>;
  clear(userId: string): boolean;
}

export function createPatternStore(
  db: Database.Database,
  options: { pepper: Buffer | Promise<Buffer>; cost?: ScryptCost; now?: () => number },
): PatternStore {
  const cost = options.cost ?? PATTERN_SCRYPT;
  const now = options.now ?? Date.now;
  const slot = oneAtATime(2);
  const stretch = (secret: Buffer, salt: Buffer, c: ScryptCost) => slot(() => scryptAsync(secret, salt, c));
  db.exec(`CREATE TABLE IF NOT EXISTS operator_pattern (
    userId TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    N INTEGER NOT NULL,
    r INTEGER NOT NULL,
    p INTEGER NOT NULL,
    misses INTEGER NOT NULL DEFAULT 0,
    lockedUntil INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )`);
  const get = db.prepare<[string], Row>("SELECT userId, salt, hash, N, r, p, misses, lockedUntil FROM operator_pattern WHERE userId = ?");
  const upsert = db.prepare(
    `INSERT INTO operator_pattern (userId, salt, hash, N, r, p, misses, lockedUntil, createdAt, updatedAt)
     VALUES (@userId, @salt, @hash, @N, @r, @p, 0, NULL, @at, @at)
     ON CONFLICT(userId) DO UPDATE SET salt = @salt, hash = @hash, N = @N, r = @r, p = @p, misses = 0, lockedUntil = NULL, updatedAt = @at`,
  );
  const setMisses = db.prepare("UPDATE operator_pattern SET misses = ?, lockedUntil = ? WHERE userId = ?");
  const remove = db.prepare("DELETE FROM operator_pattern WHERE userId = ?");

  // Bound to the user, so the same drawing makes different hashes for different operators.
  const secretOf = async (userId: string, pattern: readonly number[]) =>
    createHmac("sha256", await options.pepper).update(`${FIGURE}\0${userId}\0${pattern.join(".")}`).digest();

  const activeLock = (row: Row | undefined) => (row?.lockedUntil && row.lockedUntil > now() ? row.lockedUntil : null);

  return {
    isSet: (userId) => get.get(userId) !== undefined,
    lockedUntil: (userId) => activeLock(get.get(userId)),
    async set(userId, pattern) {
      const problem = patternProblem(pattern);
      if (problem) throw new Error(problem);
      const salt = randomBytes(16);
      const hash = await stretch(await secretOf(userId, pattern), salt, cost);
      upsert.run({ userId, salt: salt.toString("base64"), hash: hash.toString("base64"), ...cost, at: now() });
    },
    async check(userId, pattern) {
      const row = get.get(userId);
      if (!row) return { ok: false, reason: "not-set" };
      const locked = activeLock(row);
      if (locked) return { ok: false, reason: "locked", lockedUntil: locked };
      // Out-of-rule input can never match; it still costs a try so it can't probe for free.
      const valid = patternProblem(pattern) === null;
      const expected = Buffer.from(row.hash, "base64");
      const actual = valid
        ? await stretch(await secretOf(userId, pattern), Buffer.from(row.salt, "base64"), { N: row.N, r: row.r, p: row.p })
        : Buffer.alloc(expected.length);
      if (valid && actual.length === expected.length && timingSafeEqual(actual, expected)) {
        if (row.misses || row.lockedUntil) setMisses.run(0, null, userId);
        return { ok: true };
      }
      const misses = (row.lockedUntil && row.lockedUntil <= now() ? 0 : row.misses) + 1;
      if (misses >= PATTERN_MAX_MISSES) {
        const until = now() + PATTERN_LOCK_MS;
        setMisses.run(0, until, userId);
        return { ok: false, reason: "miss", triesLeft: 0, lockedUntil: until };
      }
      setMisses.run(misses, null, userId);
      return { ok: false, reason: "miss", triesLeft: PATTERN_MAX_MISSES - misses, lockedUntil: null };
    },
    clear: (userId) => remove.run(userId).changes > 0,
  };
}

export type PadRequestState = "waiting" | "approved" | "failed" | "expired";

export interface PadRequest {
  id: string;
  userId: string;
  /** The session the phone's drawing will complete: the Mac's, never sent to the phone. */
  sessionToken: string;
  expiresAt: number;
  tries: number;
  state: PadRequestState;
}

/**
 * One-time requests for drawing on a phone. In memory: they live two minutes, and a backend
 * restart only means showing a new QR code. The id rides in the QR code's URL fragment, which
 * browsers never send to a server; it can't sign anyone in without the pattern, and it ends
 * after one approval, five tries or two minutes.
 */
export function createPadRequests(options: { now?: () => number; ttlMs?: number; maxTries?: number; maxOpen?: number } = {}) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? PAD_REQUEST_TTL_MS;
  const maxTries = options.maxTries ?? PAD_REQUEST_MAX_TRIES;
  const maxOpen = options.maxOpen ?? 1000;
  const byId = new Map<string, PadRequest>();

  const refresh = (r: PadRequest) => {
    if (r.state === "waiting" && r.expiresAt <= now()) r.state = "expired";
    return r;
  };
  const sweep = () => {
    for (const [id, r] of byId) if (r.expiresAt + ttl <= now()) byId.delete(id);
    while (byId.size >= maxOpen) byId.delete(byId.keys().next().value as string);
  };

  return {
    /** A new request for this session; any earlier one from the same session ends. */
    open(userId: string, sessionToken: string): PadRequest {
      sweep();
      for (const r of byId.values()) if (r.sessionToken === sessionToken && r.state === "waiting") r.state = "expired";
      const r: PadRequest = { id: randomBytes(16).toString("base64url"), userId, sessionToken, expiresAt: now() + ttl, tries: 0, state: "waiting" };
      byId.set(r.id, r);
      return r;
    },
    get(id: string): PadRequest | null {
      const r = typeof id === "string" ? byId.get(id) : undefined;
      return r ? refresh(r) : null;
    },
    /** The latest request this session opened, for the Mac's status. */
    forSession(sessionToken: string): PadRequest | null {
      let latest: PadRequest | null = null;
      for (const r of byId.values()) if (r.sessionToken === sessionToken && (!latest || r.expiresAt >= latest.expiresAt)) latest = r;
      return latest ? refresh(latest) : null;
    },
    /** Records a drawing's outcome: approval ends it; a miss uses a try. */
    settle(r: PadRequest, ok: boolean): PadRequest {
      if (ok) r.state = "approved";
      else if (++r.tries >= maxTries) r.state = "failed";
      return r;
    },
  };
}

export type PadRequests = ReturnType<typeof createPadRequests>;
