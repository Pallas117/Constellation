// Per-account backoff for password sign-in (threat model TM-01).
//
// better-auth's own limit is per IP (5 tries a minute), so guesses spread over many addresses get through. This
// counts failed password sign-ins per submitted email instead: after `threshold` failures within `windowMs`, that
// email is paused for `baseLockMs`, doubling on each further pause up to `maxLockMs`. A success clears it.
//
// - It counts any submitted email, whether or not an account exists, so a pause never tells anyone which accounts
//   are real.
// - Emails are kept only as SHA-256 hashes, in memory, in a bounded map (oldest dropped first), so the map can't
//   grow without limit (the FM-15 lesson).
// - Only the password path is paused: passkey and SSO sign-in are untouched, so someone who pauses an account by
//   guessing can't lock its owner out of every way in. The pause is short and capped.
import { createHash } from "node:crypto";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";

export interface BackoffOptions {
  threshold: number;
  windowMs: number;
  baseLockMs: number;
  maxLockMs: number;
  maxTracked: number;
  now: () => number;
}

interface Entry {
  failures: number;
  windowStartMs: number;
  lockedUntilMs: number;
  locks: number;
}

const DEFAULTS: BackoffOptions = {
  threshold: 5,
  windowMs: 15 * 60_000,
  baseLockMs: 60_000,
  maxLockMs: 15 * 60_000,
  maxTracked: 10_000,
  now: Date.now,
};

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

  /** Records a failed sign-in; returns the pause it started in ms (0 if none). */
  fail(email: string): number {
    const key = accountKey(email);
    const now = this.opts.now();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { failures: 0, windowStartMs: now, lockedUntilMs: 0, locks: 0 };
      this.track(key, entry);
    } else if (now - entry.windowStartMs >= this.opts.windowMs) {
      // A fresh window, but keep `locks` while the last pause is recent, so a slow, patient guesser keeps doubling.
      entry.failures = 0;
      entry.windowStartMs = now;
      if (now - entry.lockedUntilMs >= this.opts.windowMs) entry.locks = 0;
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

  /** A successful sign-in clears the email's record. */
  succeed(email: string): void {
    this.entries.delete(accountKey(email));
  }

  /** How many emails are tracked (for tests and status). */
  get size(): number {
    return this.entries.size;
  }

  private track(key: string, entry: Entry): void {
    if (this.entries.size >= this.opts.maxTracked) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }
}

/** The better-auth path this guards: password sign-in only. */
export const PASSWORD_SIGN_IN_PATH = "/sign-in/email";

const emailOf = (body: unknown): string | null => {
  const email = (body as { email?: unknown } | null | undefined)?.email;
  return typeof email === "string" && email.trim() ? email : null;
};

/**
 * better-auth hooks that apply the backoff: `before` refuses a paused email with 429 (the same answer whether or not
 * the account exists); `after` counts a failed password sign-in and clears the record on success.
 */
export function backoffHooks(backoff: AccountBackoff) {
  return {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== PASSWORD_SIGN_IN_PATH) return;
      const email = emailOf(ctx.body);
      if (!email) return;
      const wait = backoff.retryAfterSeconds(email);
      if (wait > 0) {
        throw new APIError("TOO_MANY_REQUESTS", {
          message: `Too many failed sign-ins for this account. Try again in ${wait} s, or sign in with a passkey or SSO.`,
        });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== PASSWORD_SIGN_IN_PATH) return;
      const email = emailOf(ctx.body);
      if (!email) return;
      const returned = ctx.context.returned;
      // Only a refused password (401) counts: a 429 from the IP limit or a malformed request is not a guess.
      if (isAPIError(returned)) {
        if (returned.statusCode === 401) backoff.fail(email);
        return;
      }
      if (ctx.context.newSession) backoff.succeed(email);
    }),
  };
}
