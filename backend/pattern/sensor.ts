/**
 * The operator pattern as a sensor (GAU-235, Josh 2026-11-04): it notices probing, a duress
 * drawing and unusual data access, records each in CyberTiger's event log, raises an alarm (a
 * text through Argo) when it matters, and tells the operator at their next drawing.
 *
 * - Probing: two wrong drawings for one operator within 15 minutes, a lockout, or three unknown
 *   phone codes from one address within 10 minutes.
 * - Duress: the second pattern an operator can draw under pressure. Alarm at once; never shown
 *   anywhere the person at the keyboard could see it.
 * - Unusual data access (watchAccess): a session above 300 requests a minute, or touching more
 *   than 30 different routes in 5 minutes. The console polls at most every 5 s and uses about 15
 *   routes, so these are several times normal; tune with PATTERN_WATCH_RATE and _BREADTH. The
 *   session's drawing is cleared, so the console asks for the pattern again.
 * Logs and alarm texts carry user IDs and addresses, never patterns.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { NextFunction, Response } from "express";
import { roleSatisfies, type AuthContext, type AuthenticatedRequest } from "../auth.js";

export type SensorKind = "pattern-miss" | "pattern-locked" | "pad-probe" | "pad-miss" | "duress" | "data-unusual" | "identity-mismatch";
export type SensorSeverity = "low" | "medium" | "high" | "critical";

export interface SensorEvent {
  kind: SensorKind;
  userId: string | null;
  ip: string;
  at: number;
  detail: string;
}

/** Where alarms go: Argo's `notify` (masked, queued offline, rate-limited per key) or nowhere. */
export type Alarm = (title: string, message: string, key: string) => void;

const MISS_WINDOW_MS = 15 * 60_000;
const PROBE_WINDOW_MS = 10 * 60_000;
const PROBES_TO_ALARM = 3;
const KEEP_PER_USER = 50;

export function argoAlarm(env: NodeJS.ProcessEnv = process.env): Alarm | null {
  const mode = (env.PATTERN_ALERTS ?? "argo").trim().toLowerCase();
  if (mode === "off" || mode === "log") return null;
  const bin = env.ARGO_BIN?.trim() || path.join(homedir(), ".local/bin/argo");
  if (!existsSync(bin)) return null;
  return (title, message, key) => {
    execFile(bin, ["notify", "-key", key, "-every", "15m", title, message], { timeout: 10_000 }, (err) => {
      if (err) console.warn(`[pattern-sensor] alarm not sent: ${err.message}`);
    });
  };
}

export function createSensor(options: {
  alarm: Alarm | null;
  /** CyberTiger's event log (recordSensorEvent). */
  log: (e: { severity: SensorSeverity; ip: string; message: string; actorUserId?: string; path?: string }) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const byUser = new Map<string, SensorEvent[]>();
  const probesByIp = new Map<string, number[]>();

  const remember = (e: SensorEvent) => {
    if (!e.userId) return;
    const list = byUser.get(e.userId) ?? [];
    list.push(e);
    if (list.length > KEEP_PER_USER) list.splice(0, list.length - KEEP_PER_USER);
    byUser.set(e.userId, list);
    if (byUser.size > 10_000) byUser.delete(byUser.keys().next().value as string);
  };
  const raise = (title: string, message: string, key: string) => {
    try {
      options.alarm?.(title, message, key);
    } catch (err) {
      console.warn(`[pattern-sensor] alarm failed: ${(err as Error).message}`);
    }
  };
  const who = (userId: string | null) => (userId ? `operator ${userId.slice(0, 8)}` : "an unknown operator");

  return {
    record(kind: SensorKind, input: { userId: string | null; ip: string; detail?: string; path?: string }): SensorEvent {
      const e: SensorEvent = { kind, userId: input.userId, ip: input.ip, at: now(), detail: input.detail ?? "" };
      const severity: SensorSeverity =
        kind === "duress"
          ? "critical"
          : kind === "pattern-locked" || kind === "data-unusual" || kind === "identity-mismatch"
            ? "high"
            : kind === "pad-probe"
              ? "medium"
              : "low";
      options.log({ severity, ip: e.ip, message: `${kind}${e.detail ? `: ${e.detail}` : ""}`, actorUserId: e.userId ?? undefined, path: input.path });
      console.log(`[pattern-sensor] ${kind} ${e.userId ?? "-"} from ${e.ip}${e.detail ? ` (${e.detail})` : ""}`);
      remember(e);

      if (kind === "duress") {
        raise("Gauss: DURESS sign-in", `${who(e.userId)} drew their duress pattern from ${e.ip}. The session sees a console in maintenance.`, `duress-${e.userId}`);
      } else if (kind === "pattern-locked") {
        raise("Gauss: pattern locked", `Five wrong drawings locked ${who(e.userId)}'s pattern for 15 minutes (last from ${e.ip}).`, `pattern-locked-${e.userId}`);
      } else if (kind === "pattern-miss" || kind === "pad-miss") {
        const recent = (byUser.get(e.userId ?? "") ?? []).filter((x) => (x.kind === "pattern-miss" || x.kind === "pad-miss") && e.at - x.at <= MISS_WINDOW_MS);
        if (recent.length >= 2) raise("Gauss: wrong pattern drawings", `${recent.length} wrong drawings for ${who(e.userId)} in 15 minutes, last from ${e.ip}.`, `pattern-miss-${e.userId}`);
      } else if (kind === "pad-probe") {
        const times = (probesByIp.get(e.ip) ?? []).filter((t) => e.at - t <= PROBE_WINDOW_MS);
        times.push(e.at);
        probesByIp.set(e.ip, times);
        if (probesByIp.size > 10_000) probesByIp.delete(probesByIp.keys().next().value as string);
        if (times.length >= PROBES_TO_ALARM) raise("Gauss: phone codes probed", `${times.length} unknown phone codes tried from ${e.ip} in 10 minutes.`, `pad-probe-${e.ip}`);
      } else if (kind === "identity-mismatch") {
        raise("Gauss: session on the wrong device", `${who(e.userId)}'s session was used from ${e.ip}: ${e.detail}. Refused.`, `identity-${e.userId}`);
      } else if (kind === "data-unusual") {
        raise("Gauss: unusual data access", `${who(e.userId)}'s session (${e.ip}): ${e.detail}. It must draw the pattern again.`, `data-unusual-${e.userId}`);
      }
      return e;
    },

    /** What to tell the operator at their next drawing: misses, probes and access flags since `sinceMs` (never duress). */
    noticeFor(userId: string, sinceMs: number): { misses: number; probes: number; unusual: number; lastIp: string | null; lastAt: number | null } {
      const list = (byUser.get(userId) ?? []).filter((e) => e.at > sinceMs && e.kind !== "duress");
      const last = list.at(-1) ?? null;
      return {
        misses: list.filter((e) => e.kind === "pattern-miss" || e.kind === "pad-miss" || e.kind === "pattern-locked").length,
        probes: list.filter((e) => e.kind === "pad-probe").length,
        unusual: list.filter((e) => e.kind === "data-unusual").length,
        lastIp: last?.ip ?? null,
        lastAt: last?.at ?? null,
      };
    },
  };
}

export type Sensor = ReturnType<typeof createSensor>;

/**
 * Mounted on /api after the policy check: watches each operator or admin session's requests and
 * clears its drawing when they look like bulk reading rather than the console.
 */
export function watchAccess(options: {
  sensor: Sensor;
  /** Clears the session's drawing (and forgets its passkey's daily drawing). */
  clearDrawing: (auth: AuthContext) => Promise<void>;
  ipOf: (req: AuthenticatedRequest) => string;
  ratePerMinute?: number;
  breadthPer5Min?: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const rate = options.ratePerMinute ?? 300;
  const breadth = options.breadthPer5Min ?? 30;
  const sessions = new Map<string, { hits: number[]; routes: Map<string, number>; flaggedAt: number }>();

  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (!auth || auth.token === "dev-bypass" || !roleSatisfies(auth.role, "operator") || !auth.pattern?.verifiedAt) {
      next();
      return;
    }
    const t = now();
    const s = sessions.get(auth.token) ?? { hits: [], routes: new Map<string, number>(), flaggedAt: 0 };
    s.hits.push(t);
    while (s.hits.length && t - s.hits[0] > 60_000) s.hits.shift();
    const route = `${req.method} ${req.path.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, "/:id")}`;
    s.routes.set(route, t);
    for (const [r, at] of s.routes) if (t - at > 5 * 60_000) s.routes.delete(r);
    sessions.set(auth.token, s);
    if (sessions.size > 5_000) sessions.delete(sessions.keys().next().value as string);

    const tooFast = s.hits.length > rate;
    const tooWide = s.routes.size > breadth;
    if ((tooFast || tooWide) && t - s.flaggedAt > 10 * 60_000) {
      s.flaggedAt = t;
      const detail = tooFast ? `${s.hits.length} requests in a minute` : `${s.routes.size} different routes in 5 minutes`;
      options.sensor.record("data-unusual", { userId: auth.userId, ip: options.ipOf(req), detail, path: req.path });
      void options.clearDrawing(auth).catch((err: unknown) => console.warn(`[pattern-sensor] could not clear the drawing: ${(err as Error).message}`));
    }
    next();
  };
}
