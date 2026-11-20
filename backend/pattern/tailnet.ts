/**
 * Operator sessions tied to the tailnet identity (GAU-235, Josh 2026-11-04). The console answers
 * only on the tailnet, and Tailscale knows which person owns every device on it. On each operator
 * or admin request this asks Tailscale who owns the device the request came from and refuses it
 * (428 TAILNET_IDENTITY, never 401/403, so a misconfiguration can't get your own address blocked)
 * unless that is the account's owner. A copied session cookie is then useless on anyone else's
 * device, and the sensor raises the alarm.
 *
 * - A request through a proxy on this Mac (tailscale serve, the ops proxy) carries the device's
 *   tailnet address in X-Forwarded-For (CyberTiger's extractClientIp); one straight from this Mac
 *   is this Mac's own owner (`tailscale status`).
 * - The account's email must equal the Tailscale login, unless TAILNET_LOGIN_MAP says otherwise:
 *   "jzwnathan@lightbound.uk=someone@gmail.com,ops@lightbound.uk=…".
 * - TAILNET_IDENTITY=off turns it off; without a tailscale binary it is off.
 * Lookups are cached for a minute per address (five for this Mac's owner).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { NextFunction, Response } from "express";
import { roleSatisfies, type AuthenticatedRequest } from "../auth.js";
import { policyFor } from "../rbac.js";
import type { Sensor } from "./sensor.js";

export const TAILNET_IDENTITY = "TAILNET_IDENTITY";

export interface TailnetLookup {
  /** The Tailscale login that owns the device at this tailnet address, or null. */
  whois(ip: string): Promise<string | null>;
  /** The Tailscale login that owns this Mac, or null. */
  self(): Promise<string | null>;
}

const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.");
const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/; // 100.64.0.0/10
const isTailnet = (ip: string) => TAILNET_V4.test(ip) || ip.toLowerCase().startsWith("fd7a:115c:a1e0:");

export function loginMapFrom(env: NodeJS.ProcessEnv = process.env): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const pair of (env.TAILNET_LOGIN_MAP ?? "").split(",")) {
    const [email, login] = pair.split("=").map((s) => s?.trim().toLowerCase());
    if (email && login) map.set(email, [...(map.get(email) ?? []), login]);
  }
  return map;
}

/** Tailscale's own CLI, cached; null when there is no tailscale binary. */
export function tailscaleLookup(env: NodeJS.ProcessEnv = process.env): TailnetLookup | null {
  const bin = env.TAILSCALE_BIN?.trim() || ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale"].find((p) => existsSync(p));
  if (!bin || !existsSync(bin)) return null;
  const run = (args: string[]) =>
    new Promise<unknown>((resolve) =>
      execFile(bin, args, { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve(null);
        }
      }),
    );
  const cache = new Map<string, { at: number; login: string | null }>();
  const cached = async (key: string, ttl: number, load: () => Promise<string | null>) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.login;
    const login = await load();
    cache.set(key, { at: Date.now(), login });
    if (cache.size > 2_000) cache.delete(cache.keys().next().value as string);
    return login;
  };
  return {
    whois: (ip) =>
      cached(`ip:${ip}`, 60_000, async () => {
        const d = (await run(["whois", "--json", ip])) as { UserProfile?: { LoginName?: string } } | null;
        return d?.UserProfile?.LoginName?.toLowerCase() ?? null;
      }),
    self: () =>
      cached("self", 300_000, async () => {
        const d = (await run(["status", "--json"])) as { Self?: { UserID?: number }; User?: Record<string, { LoginName?: string }> } | null;
        const id = d?.Self?.UserID;
        return id !== undefined ? (d?.User?.[String(id)]?.LoginName?.toLowerCase() ?? null) : null;
      }),
  };
}

export function tailnetIdentity(options: {
  lookup: TailnetLookup | null;
  sensor: Sensor;
  ipOf: (req: AuthenticatedRequest) => string;
  loginMap?: Map<string, string[]>;
  enabled?: () => boolean;
}) {
  const enabled = options.enabled ?? (() => (process.env.TAILNET_IDENTITY ?? "").trim().toLowerCase() !== "off");
  const map = options.loginMap ?? loginMapFrom();

  /** null when the device's owner is the account's owner (or the check is off), else what to say. */
  const check = async (req: AuthenticatedRequest): Promise<{ ip: string; login: string | null } | null> => {
    const auth = req.auth;
    if (!options.lookup || !enabled() || !auth || auth.token === "dev-bypass") return null;
    const ip = options.ipOf(req);
    const login = isLoopback(ip) ? await options.lookup.self() : isTailnet(ip) ? await options.lookup.whois(ip) : null;
    const email = auth.email?.toLowerCase() ?? "";
    const expected = map.get(email) ?? [email];
    return login && expected.includes(login) ? null : { ip, login };
  };

  const middleware = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const access = policyFor(req.method, req.path)?.access;
    if (!req.auth || !access || access === "public" || !roleSatisfies(access, "operator")) {
      next();
      return;
    }
    const mismatch = await check(req);
    if (!mismatch) {
      next();
      return;
    }
    options.sensor.record("identity-mismatch", {
      userId: req.auth.userId,
      ip: mismatch.ip,
      detail: mismatch.login ? `device belongs to another Tailscale login` : `device not on the tailnet`,
      path: req.path,
    });
    res.status(428).json({ error: "This device isn't signed in to Tailscale as you.", code: TAILNET_IDENTITY });
  };

  return { middleware, check };
}
