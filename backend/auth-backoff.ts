// Per-account backoff for password sign-in (threat model TM-01).
//
// better-auth's own limit is per IP (5 tries a minute), so guesses spread over many addresses get through. This
// counts failed password sign-ins per submitted email instead: after `threshold` failures within `windowMs`, that
// email is paused for `baseLockMs`, doubling on each further pause up to `maxLockMs`. A success clears it.
//
// - Each attempt is reserved before the password is checked, and refused when failures + attempts still being
//   checked would reach the threshold. So a burst of sign-ins sent at once from many addresses gets `threshold`
//   guesses, not `threshold` per address. A reservation ends with its answer, or by itself after `reservationMs`.
// - It counts any submitted email, whether or not an account exists, so a pause never tells anyone which accounts
//   are real.
// - Emails are kept only as SHA-256 hashes, in memory, in a bounded map, so the map can't grow without limit (the
//   FM-15 lesson). When it is full, the email with the oldest last failure is dropped first, never one whose pause
//   is still running (dropping that would hand the guesser a fresh start).
// - Only the password path is paused: SSO sign-in is untouched. Someone guessing from outside can still keep an
//   account's password sign-in paused, so there are two ways out: a caller on the machine itself (CyberTiger's
//   direct-local rule, decided by the server, never by a header a client sent) is not paused or counted, and an
//   admin can clear a pause (POST /api/security/account-backoff/unpause).
import { createHash } from "node:crypto";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";

export interface BackoffOptions {
  threshold: number;
  windowMs: number;
  baseLockMs: number;
  maxLockMs: number;
  /** How long an attempt stays reserved if its answer never arrives (ms). */
  reservationMs: number;
  maxTracked: number;
  now: () => number;
}

interface Entry {
  failures: number;
  windowStartMs: number;
  lockedUntilMs: number;
  locks: number;
  /** Attempts being checked right now: the time each reservation lapses (ms). At most `threshold` long. */
  pending: number[];
}

const DEFAULTS: BackoffOptions = {
  threshold: 5,
  windowMs: 15 * 60_000,
  baseLockMs: 60_000,
  maxLockMs: 15 * 60_000,
  reservationMs: 30_000,
  maxTracked: 10_000,
  now: Date.now,
};

/** Retry-After (s) when an email is refused only because other attempts for it are still being checked. */
const BUSY_RETRY_S = 1;

/** The email as typed, normalised the way accounts are matched (trimmed, lower case), then hashed. */
export const accountKey = (email: string): string => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

export class AccountBackoff {
  private readonly opts: BackoffOptions;
  private readonly entries = new Map<string, Entry>();

  constructor(options: Partial<BackoffOptions> = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Seconds until this email may try again, or 0 if it may try now. */
  retryAfterSeconds(email: string): number {
    const entry = this.entries.get(accountKey(email));
    const left = entry ? entry.lockedUntilMs - this.opts.now() : 0;
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /**
   * Reserves one attempt for this email before its password is checked. Returns 0 when reserved, else the seconds
   * to wait: the pause that is running, or a moment when failures plus attempts still being checked already reach
   * the threshold. Check and reserve happen in one synchronous step, so concurrent sign-ins can't all slip past.
   * Every reservation must end in `fail(email, true)`, `succeed(email, true)` or `release(email)`.
   */
  reserve(email: string): number {
    const key = accountKey(email);
    const now = this.opts.now();
    let entry = this.entries.get(key);
    if (entry) {
      if (entry.lockedUntilMs > now) return Math.ceil((entry.lockedUntilMs - now) / 1000);
      this.roll(entry, now);
      entry.pending = entry.pending.filter((lapsesMs) => lapsesMs > now);
      if (entry.failures + entry.pending.length >= this.opts.threshold) return BUSY_RETRY_S;
    } else {
      entry = { failures: 0, windowStartMs: now, lockedUntilMs: 0, locks: 0, pending: [] };
      // A full map of running pauses: let the attempt through uncounted rather than grow without limit.
      if (!this.track(key, entry)) return 0;
    }
    entry.pending.push(now + this.opts.reservationMs);
    return 0;
  }

  /** Ends a reservation that was neither a refused password nor a sign-in (a malformed request, the IP limit). */
  release(email: string): void {
    const key = accountKey(email);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.pending.shift();
    if (entry.failures === 0 && entry.locks === 0 && entry.pending.length === 0) this.entries.delete(key);
  }

  /**
   * Records a failed sign-in; returns the pause it started in ms (0 if none). `reserved` says the attempt held a
   * reservation from `reserve()`, which this ends.
   */
  fail(email: string, reserved = false): number {
    const key = accountKey(email);
    const now = this.opts.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { failures: 0, windowStartMs: now, lockedUntilMs: 0, locks: 0, pending: [] };
      if (!this.track(key, entry)) return 0;
    } else {
      this.roll(entry, now);
      if (reserved) entry.pending.shift();
      // Move to the end: the map's order is "last failure", so the first entries are the stalest.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    entry.failures += 1;
    if (entry.failures < this.opts.threshold) return 0;
    const pause = Math.min(this.opts.baseLockMs * 2 ** entry.locks, this.opts.maxLockMs);
    entry.locks += 1;
    entry.failures = 0;
    entry.windowStartMs = now;
    entry.lockedUntilMs = now + pause;
    return pause;
  }

  /** A successful sign-in clears the email's record (attempts still being checked stay reserved). */
  succeed(email: string, reserved = false): void {
    const key = accountKey(email);
    const entry = this.entries.get(key);
    if (!entry) return;
    if (reserved) entry.pending.shift();
    const now = this.opts.now();
    entry.pending = entry.pending.filter((lapsesMs) => lapsesMs > now);
    if (entry.pending.length === 0) {
      this.entries.delete(key);
      return;
    }
    entry.failures = 0;
    entry.locks = 0;
    entry.lockedUntilMs = 0;
    entry.windowStartMs = now;
  }

  /** Admin action: forget this email's failures and pause. Returns whether there was anything to clear. */
  unpause(email: string): boolean {
    return this.entries.delete(accountKey(email));
  }

  /** How many emails are tracked (for tests and status). */
  get size(): number {
    return this.entries.size;
  }

  /** A fresh window, but keep `locks` while the last pause is recent, so a slow, patient guesser keeps doubling. */
  private roll(entry: Entry, now: number): void {
    if (now - entry.windowStartMs < this.opts.windowMs) return;
    entry.failures = 0;
    entry.windowStartMs = now;
    if (now - entry.lockedUntilMs >= this.opts.windowMs) entry.locks = 0;
  }

  /** Adds an entry, keeping the map bounded. False when it is full of running pauses (nothing may be dropped). */
  private track(key: string, entry: Entry): boolean {
    if (this.entries.size >= this.opts.maxTracked) {
      const now = this.opts.now();
      for (const [candidate, held] of this.entries) {
        if (held.lockedUntilMs > now) continue;
        this.entries.delete(candidate);
        break;
      }
      if (this.entries.size >= this.opts.maxTracked) return false;
    }
    this.entries.set(key, entry);
    return true;
  }
}

/** The better-auth path this guards: password sign-in only. */
export const PASSWORD_SIGN_IN_PATH = "/sign-in/email";

/**
 * Marks a request from a caller on this machine (CyberTiger's `isDirectLocal`). backend/server.ts sets it on every
 * /api/auth request from the connection itself and removes whatever a client sent, so it can't be claimed.
 */
export const DIRECT_LOCAL_HEADER = "x-gauss-direct-local";

const emailOf = (body: unknown): string | null => {
  const email = (body as { email?: unknown } | null | undefined)?.email;
  return typeof email === "string" && email.trim() ? email : null;
};

const refusal = (waitS: number) =>
  new APIError(
    "TOO_MANY_REQUESTS",
    { message: `Too many failed sign-ins for this account. Try again in ${waitS} s.` },
    { "Retry-After": String(waitS) },
  );

/**
 * better-auth hooks that apply the backoff: `before` reserves the attempt, or refuses a paused email with 429 and
 * Retry-After (the same answer whether or not the account exists); `after` counts a refused password, clears the
 * record on success, and otherwise just ends the reservation. A direct-local caller is neither paused nor counted.
 */
export function backoffHooks(backoff: AccountBackoff) {
  // Requests holding a reservation, so `after` only ends one that this request's `before` made.
  const holding = new WeakSet<Request>();
  const guarded = (ctx: { path?: string; body?: unknown; headers?: Headers }): string | null => {
    if (ctx.path !== PASSWORD_SIGN_IN_PATH) return null;
    if (ctx.headers?.get(DIRECT_LOCAL_HEADER) === "1") return null;
    return emailOf(ctx.body);
  };
  return {
    before: createAuthMiddleware(async (ctx) => {
      const email = guarded(ctx);
      if (!email) return;
      const request = ctx.request;
      // A call with no HTTP request (server code) can't be followed to its answer: check the pause only.
      const waitS = request ? backoff.reserve(email) : backoff.retryAfterSeconds(email);
      if (waitS > 0) throw refusal(waitS);
      if (request) holding.add(request);
    }),
    after: createAuthMiddleware(async (ctx) => {
      const email = guarded(ctx);
      if (!email) return;
      const held = ctx.request ? holding.delete(ctx.request) : false;
      const returned = ctx.context.returned;
      // Only a refused password (401) counts: a 429 from the IP limit or a malformed request is not a guess.
      if (isAPIError(returned)) {
        if (returned.statusCode === 401) backoff.fail(email, held);
        else if (held) backoff.release(email);
        return;
      }
      if (ctx.context.newSession) backoff.succeed(email, held);
      else if (held) backoff.release(email);
    }),
  };
}
