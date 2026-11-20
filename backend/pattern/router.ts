import express, { type Response } from "express";
import { roleSatisfies, type AuthenticatedRequest } from "../auth.js";
import { PATTERN_REQUIRED } from "../rbac.js";
import { patternProblem, VERTICES, type PadRequests, type PatternCheck, type PatternStore } from "./store.js";

/**
 * /api/operator-pattern (GAU-235). Policies in backend/rbac.ts: status, verify and phone
 * requests need a session; setting or changing the pattern also needs a passkey touch in the
 * last 5 minutes (step-up), and changing it needs the current pattern first. The two /pad
 * routes are public: the phone has no session, only the one-time request id from the QR code.
 *
 * Wrong drawings are answered 200 with ok: false, never 401/403, so they don't count toward
 * CyberTiger's address block; the per-operator lockout and the per-address limiter bound them.
 */
export interface PatternRouterDeps {
  store: PatternStore;
  requests: PadRequests;
  /** Marks a better-auth session as having passed the pattern check. */
  markSession(sessionToken: string, at: Date): Promise<void>;
  /** Records on the user whether a pattern is set, so their sessions carry it. */
  markUser(userId: string, setAt: Date | null): Promise<void>;
  /** The newest passkey's public key (base64), for drawing the operator's geometry on the phone. */
  geometryKeyFor(userId: string): string | null;
  /** Whether operator and admin routes need the pattern (OPERATOR_PATTERN, default on). */
  required(): boolean;
  /** Where phones open the pad (PATTERN_PAD_ORIGIN, e.g. the tailnet share), or null. */
  padOrigin: string | null;
  now?: () => number;
}

const isPattern = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length <= 64 && v.every((x) => Number.isInteger(x) && x >= 0 && x < VERTICES);

const requestIdOf = (body: unknown): string | null => {
  const id = (body as { request?: unknown } | null)?.request;
  return typeof id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
};

function answer(res: Response, check: PatternCheck, extra: Record<string, unknown> = {}) {
  if (check.ok) {
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

  router.get("/status", (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    const request = deps.requests.forSession(auth.token);
    res.json({
      required: deps.required() && roleSatisfies(auth.role, "operator"),
      set: deps.store.isSet(auth.userId),
      verified: Boolean(auth.pattern?.verifiedAt),
      lockedUntil: deps.store.lockedUntil(auth.userId),
      padOrigin: deps.padOrigin,
      request: request ? { state: request.state, expiresAt: request.expiresAt } : null,
    });
  });

  // Set or change (step-up in rbac.ts). Changing needs the current pattern in this session.
  router.post("/", async (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    const pattern = (req.body as { pattern?: unknown } | null)?.pattern;
    if (!isPattern(pattern)) {
      res.status(400).json({ error: "Send the pattern as vertex numbers." });
      return;
    }
    const problem = patternProblem(pattern);
    if (problem) {
      res.status(400).json({ error: problem.charAt(0).toUpperCase() + problem.slice(1) + "." });
      return;
    }
    if (deps.store.isSet(auth.userId) && !auth.pattern?.verifiedAt) {
      res.status(428).json({ error: "Draw your current pattern before setting a new one.", code: PATTERN_REQUIRED });
      return;
    }
    const at = new Date(now());
    await deps.store.set(auth.userId, pattern);
    await deps.markUser(auth.userId, at);
    await deps.markSession(auth.token, at);
    console.log(`[pattern] ${auth.userId} set an operator pattern`);
    res.json({ ok: true });
  });

  router.post("/verify", async (req: AuthenticatedRequest, res) => {
    const auth = req.auth!;
    const pattern = (req.body as { pattern?: unknown } | null)?.pattern;
    if (!isPattern(pattern)) {
      res.status(400).json({ error: "Send the pattern as vertex numbers." });
      return;
    }
    const check = await deps.store.check(auth.userId, pattern);
    if (check.ok) await deps.markSession(auth.token, new Date(now()));
    else console.log(`[pattern] ${auth.userId} missed (${check.reason})`);
    answer(res, check);
  });

  // The Mac asks for a phone drawing; the QR code carries the id in its URL fragment.
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
      res.status(410).json({ state: "expired", error: "This code has expired. Show a new one on the computer." });
      return;
    }
    res.json({ state: r.state, expiresAt: r.expiresAt, geometryKey: deps.geometryKeyFor(r.userId) });
  });

  // Public: the phone's drawing. Completes the Mac's session on a match.
  router.post("/pad", async (req, res) => {
    const id = requestIdOf(req.body);
    const pattern = (req.body as { pattern?: unknown } | null)?.pattern;
    const r = id ? deps.requests.get(id) : null;
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
    if (check.ok) {
      await deps.markSession(r.sessionToken, new Date(now()));
      console.log(`[pattern] ${r.userId} drew their pattern on a phone`);
    } else {
      console.log(`[pattern] ${r.userId} missed on a phone (${check.reason})`);
    }
    answer(res, check, { state: r.state });
  });

  return router;
}
