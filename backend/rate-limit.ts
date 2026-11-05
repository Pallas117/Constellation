import type { NextFunction, Request, Response } from "express";

export interface WindowLimitOptions {
  windowMs: number;
  max: number;
  /** Who is counted, e.g. CyberTiger's client IP. */
  keyOf: (req: Request) => string;
  /** Bound on tracked clients: past it, expired windows are swept and then the oldest dropped. */
  maxKeys?: number;
  message?: string;
  now?: () => number;
}

/**
 * Fixed-window limiter for a small set of sensitive routes (the passkey
 * ceremonies under /api/auth, which sit in front of CyberTiger). Answers 429
 * with Retry-After, never 401/403, so it never feeds CyberTiger's auth-failure
 * block. Memory stays bounded by maxKeys.
 */
export function windowLimit(options: WindowLimitOptions) {
  const { windowMs, max, keyOf, maxKeys = 10_000, message = "Too many requests. Try again shortly.", now = Date.now } = options;
  const windows = new Map<string, { start: number; count: number }>();

  function sweep(at: number) {
    for (const [key, window] of windows) if (at - window.start >= windowMs) windows.delete(key);
    // Map iteration is insertion order, so this drops the oldest clients first.
    for (const key of windows.keys()) {
      if (windows.size < maxKeys) break;
      windows.delete(key);
    }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const at = now();
    const key = keyOf(req);
    let window = windows.get(key);
    if (!window || at - window.start >= windowMs) {
      if (!window && windows.size >= maxKeys) sweep(at);
      window = { start: at, count: 0 };
      windows.delete(key);
      windows.set(key, window);
    }
    window.count += 1;
    if (window.count > max) {
      res.setHeader("retry-after", String(Math.max(1, Math.ceil((window.start + windowMs - at) / 1000))));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}
