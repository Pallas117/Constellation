import express, { type Response } from "express";
import { roleSatisfies, type AuthenticatedRequest } from "../auth.js";
import { PATTERN_REQUIRED } from "../rbac.js";
import type { Sensor } from "./sensor.js";
import { patternProblem, VERTICES, type PadRequests, type PatternCheck, type PatternStore } from "./store.js";

/**
 * /api/operator-pattern (GAU-235). Policies in backend/rbac.ts: status, verify and phone
 * requests need a session; setting or changing the pattern (or the duress pattern) also needs a
 * passkey touch in the last 5 minutes (step-up) and the current pattern drawn in this session.
 * The two /pad routes are public: the phone has no session, only the one-time request id from
 * the QR code.
 *
 * Wrong drawings are answered 200 with ok: false, never 401/403, so they don't count toward
 * CyberTiger's address block; the per-operator lockout and the per-address limiter bound them.
 * The sensor (./sensor.ts) hears every miss, lockout, unknown phone code and duress drawing.
 * A duress drawing is answered exactly like a good one; the session is marked, and nothing it can
 * read says so.
 */
export interface PatternRouterDeps {
  store: PatternStore;
  requests: PadRequests;
  sensor: Sensor;
  /** Marks a better-auth session as having passed the pattern check. */
  markSession(sessionToken: string, at: Date): Promise<void>;
  /** Marks a session as signed in under duress. */
  markDuress(sessionToken: string, at: Date): Promise<void>;
  /** Records on the user whether a pattern is set, so their sessions carry it. */
  markUser(userId: string, setAt: Date | null): Promise<void>;
  /** The newest passkey's public key (base64), for drawing the operator's geometry on the phone. */
  geometryKeyFor(userId: string): string | null;
  /** Whether operator and admin routes need the pattern (OPERATOR_PATTERN, default on). */
  required(): boolean;
  /** Where phones open the pad (PATTERN_PAD_ORIGIN, e.g. the tailnet share), or null. */
  padOrigin: string | null;
  /** The client's address, as CyberTiger sees it. */
  ipOf(req: express.Request): string;
  now?: () => number;
}

const MAINTENANCE = "The operator console is in maintenance. Try again later.";

const isPattern = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length <= 64 && v.every((x) => Number.isInteger(x) && x >= 0 && x < VERTICES);

const requestIdOf = (body: unknown): string | null => {
  const id = (body as { request?: unknown } | null)?.request;
  return typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
};

const sentence = (problem: string) => problem.charAt(0).toUpperCase() + problem.slice(1) + ".";

function answer(res: Response, check: PatternCheck, extra: Record<string, unknown> = {}) {
  if (check.ok) {
    // Never `duress`: a duress drawing must look exactly like a good one.
    res.json({ ok: true, ...extra });
    return;
  }
  const message =
    check.reason === "locked" || (check.reason === "miss" && check.lockedUntil)
      ? "Too many misses: the pattern is locked for 15 minutes."
      : check.reason === "not-set"
        ? "No pattern is set for this account yet."
        : `That's not your pattern. ${check.triesLeft} ${check.triesLeft === 1 ? "try" : "tries"} left.`;
  res.json({ ...check, message, ...extra });
}

export function createPatternRouter(deps: PatternRouterDeps): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;

  // What a drawing's outcome tells the sensor, and the session marks a good (or duress) one gets.
  const settle = async (check: PatternCheck, who: { userId: string; ip: string; sessionToken: string; phone: boolean }) => {
    if (check.ok) {
      const at = new Date(now());
      await deps.markSession(who.sessionToken, at);
      if (check.duress) {
        await deps.markDuress(who.sessionToken, at);
        deps.sensor.record("duress", { userId: who.userId, ip: who.ip, detail: who.phone ? "drawn on a phone" : "drawn at the computer" });
      }
      return;
    }
    if (check.reason === "locked" || (check.reason === "miss" && check.lockedUntil)) {
      deps.sensor.record("pattern-locked", { userId: who.userId, ip: who.ip });
    } else if (check.reason === "miss") {
      deps.sensor.record(who.phone ? "pad-miss" : "pattern-miss", { userId: who.userId, ip: who.ip, detail: `${check.triesLeft} tries left` });
    }
  };

  router.get("/status", (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    const request = deps.requests.forSession(auth.token);
    const duress = Boolean(auth.pattern?.duress);
    res.json({
      required: deps.required() && roleSatisfies(auth.role, "operator"),
      set: deps.store.isSet(auth.userId),
      verified: Boolean(auth.pattern?.verifiedAt),
      // A duress session is told there is no duress pattern.
      duressSet: !duress && deps.store.hasDuress(auth.userId),
      lockedUntil: deps.store.lockedUntil(auth.userId),
      padOrigin: deps.padOrigin,
      request: request ? { state: request.state, expiresAt: request.expiresAt } : null,
      // Misses, probed codes and access flags since the last good drawing (never the duress alarm).
      notice: deps.sensor.noticeFor(auth.userId, deps.store.lastDrawnAt(auth.userId) ?? 0),
    });
  });

  // Set or change (step-up in rbac.ts). Changing needs the current pattern in this session.
  router.post("/", async (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    if (auth.pattern?.duress) {
      res.status(503).json({ error: MAINTENANCE });
      return;
    }
    const pattern = (req.body as { pattern?: unknown } | null)?.pattern;
    if (!isPattern(pattern)) {
      res.status(400).json({ error: "Send the pattern as vertex numbers." });
      return;
    }
    const problem = patternProblem(pattern);
    if (problem) {
      res.status(400).json({ error: sentence(problem) });
      return;
    }
    if (deps.store.isSet(auth.userId) && !auth.pattern?.verifiedAt) {
      res.status(428).json({ error: "Draw your current pattern before setting a new one.", code: PATTERN_REQUIRED });
      return;
    }
    try {
      await deps.store.set(auth.userId, pattern);
    } catch (err) {
      res.status(400).json({ error: sentence((err as Error).message) });
      return;
    }
    const at = new Date(now());
    await deps.markUser(auth.userId, at);
    await deps.markSession(auth.token, at);
    console.log(`[pattern] ${auth.userId} set an operator pattern`);
    res.json({ ok: true });
  });

  // The duress pattern: set or remove it (step-up in rbac.ts), with the real pattern drawn in this session.
  const duressGuard = (auth: NonNullable<AuthenticatedRequest["auth"]>, res: Response): boolean => {
    if (auth.pattern?.duress) {
      res.status(503).json({ error: MAINTENANCE });
      return false;
    }
    if (!deps.store.isSet(auth.userId) || !auth.pattern?.verifiedAt) {
      res.status(428).json({ error: "Draw your pattern first.", code: PATTERN_REQUIRED });
      return false;
    }
    return true;
  };
  router.post("/duress", async (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    if (!duressGuard(auth, res)) return;
    const pattern = (req.body as { pattern?: unknown } | null)?.pattern;
    if (!isPattern(pattern)) {
      res.status(400).json({ error: "Send the pattern as vertex numbers." });
      return;
    }
    try {
      await deps.store.setDuress(auth.userId, pattern);
    } catch (err) {
      res.status(400).json({ error: sentence((err as Error).message) });
      return;
    }
    console.log(`[pattern] ${auth.userId} set a duress pattern`);
    res.json({ ok: true });
  });
  router.delete("/duress", (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    if (!duressGuard(auth, res)) return;
    const removed = deps.store.clearDuress(auth.userId);
    console.log(`[pattern] ${auth.userId} removed their duress pattern`);
    res.json({ ok: true, removed });
  });

  router.post("/verify", async (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    const pattern = (req.body as { pattern?: unknown } | null)?.pattern;
    if (!isPattern(pattern)) {
      res.status(400).json({ error: "Send the pattern as vertex numbers." });
      return;
    }
    const check = await deps.store.check(auth.userId, pattern);
    await settle(check, { userId: auth.userId, ip: deps.ipOf(req), sessionToken: auth.token, phone: false });
    answer(res, check);
  });

  // The computer asks for a phone drawing; the QR code carries the id in its URL fragment.
  router.post("/requests", (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    if (!deps.padOrigin) {
      res.status(409).json({ error: "Drawing on a phone isn't set up on this server (PATTERN_PAD_ORIGIN)." });
      return;
    }
    if (!deps.store.isSet(auth.userId)) {
      res.status(409).json({ error: "Set your pattern on this screen first." });
      return;
    }
    const r = deps.requests.open(auth.userId, auth.token);
    res.json({ id: r.id, expiresAt: r.expiresAt, padUrl: `${deps.padOrigin}/pad#${r.id}` });
  });

  // Public: what the phone needs to draw (the request's state and the operator's figure).
  router.post("/pad/info", (req, res) => {
    const id = requestIdOf(req.body);
    const r = id ? deps.requests.get(id) : null;
    if (!r) {
      deps.sensor.record("pad-probe", { userId: null, ip: deps.ipOf(req), detail: id ? "unknown phone code" : "malformed phone code" });
      res.status(410).json({ state: "expired", error: "This code has expired. Show a new one on the computer." });
      return;
    }
    res.json({ state: r.state, expiresAt: r.expiresAt, geometryKey: deps.geometryKeyFor(r.userId) });
  });

  // Public: the phone's drawing. Completes the computer's session on a match.
  router.post("/pad", async (req, res) => {
    const id = requestIdOf(req.body);
    const pattern = (req.body as { pattern?: unknown } | null)?.pattern;
    const r = id ? deps.requests.get(id) : null;
    if (!r) deps.sensor.record("pad-probe", { userId: null, ip: deps.ipOf(req), detail: id ? "unknown phone code" : "malformed phone code" });
    if (!r || r.state !== "waiting") {
      res.status(410).json({ state: r?.state ?? "expired", error: "This code is no longer valid. Show a new one on the computer." });
      return;
    }
    if (!isPattern(pattern)) {
      res.status(400).json({ error: "Send the pattern as vertex numbers." });
      return;
    }
    const check = await deps.store.check(r.userId, pattern);
    deps.requests.settle(r, check.ok);
    await settle(check, { userId: r.userId, ip: deps.ipOf(req), sessionToken: r.sessionToken, phone: true });
    if (check.ok) console.log(`[pattern] ${r.userId} drew their pattern on a phone`);
    answer(res, check, { state: r.state });
  });

  return router;
}
