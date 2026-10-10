import type { NextFunction, Response } from "express";
import { roleSatisfies, type AuthenticatedRequest, type AuthRole } from "./auth.js";

/**
 * The single source of truth for who may call which API route.
 *
 * - "public": no session needed (the open landing visualisation)
 * - a role: that role or higher (user < staff < operator < admin)
 *
 * Every /api route must appear here; anything unlisted is denied
 * (backend/rbac.test.ts fails if a route is added without a policy).
 * Routers may add finer checks on top, e.g. device ownership.
 * Not listed because they never reach this middleware: /api/auth/* (better-auth),
 * /api/sso-options (public, registered first) and POST /api/mesh/report
 * (Argo device token, registered before session auth).
 */
export type Access = "public" | AuthRole;

export const API_POLICY: ReadonlyArray<{ method: string; path: string; access: Access }> = [
  // Open landing visualisation
  { method: "GET", path: "/feed/space-weather/latest", access: "public" },
  { method: "GET", path: "/system/connectivity", access: "public" },

  // Free account (user): richer feeds behind sign-in
  { method: "GET", path: "/feed/space-weather/5s", access: "user" },
  { method: "GET", path: "/feed/space-weather/latest/proto", access: "user" },
  { method: "GET", path: "/feed/space-objects", access: "user" },
  { method: "GET", path: "/feed/aurora/map", access: "user" },
  { method: "GET", path: "/feed/mms/reconnection", access: "user" },
  { method: "GET", path: "/feed/mms/reconnection/latest", access: "user" },
  { method: "GET", path: "/feed/sources/status", access: "user" },
  { method: "GET", path: "/forecast/anomaly", access: "user" },

  // Own devices (login device binding); the router checks ownership
  { method: "GET", path: "/device", access: "user" },
  { method: "POST", path: "/device/register", access: "user" },
  { method: "GET", path: "/device/:id", access: "user" },
  { method: "POST", path: "/device/:id/heartbeat", access: "user" },
  { method: "POST", path: "/device/:id/status", access: "user" },
  { method: "POST", path: "/device/:id/telemetry", access: "user" },
  { method: "POST", path: "/device/:id/proof", access: "user" },

  // Staff: onboard their own devices onto the mesh; the router adds ownership
  // and operator-only team views
  { method: "GET", path: "/mesh/onboarding", access: "staff" },
  { method: "GET", path: "/mesh/devices", access: "staff" },
  { method: "POST", path: "/mesh/devices", access: "staff" },
  { method: "DELETE", path: "/mesh/devices/:name", access: "staff" },

  // Operators: console tools
  { method: "GET", path: "/rag/status", access: "operator" },
  { method: "POST", path: "/rag/index", access: "operator" },
  { method: "POST", path: "/rag/query", access: "operator" },
  { method: "GET", path: "/security/cybertiger/status", access: "operator" },
  { method: "POST", path: "/ai/nowcast/infer", access: "operator" },
  { method: "GET", path: "/device/swap/plan", access: "operator" },
  { method: "POST", path: "/device/swap/rebalance", access: "operator" },
  { method: "POST", path: "/device/:id/quality", access: "operator" },

  // Admins: security controls and model training
  { method: "GET", path: "/security/cybertiger/events", access: "admin" },
  { method: "POST", path: "/security/cybertiger/block", access: "admin" },
  { method: "POST", path: "/security/cybertiger/unblock", access: "admin" },
  { method: "POST", path: "/ai/nowcast/train", access: "admin" },
];

function matches(pattern: string, path: string): boolean {
  const a = pattern.split("/");
  const b = path.replace(/\/+$/, "").split("/");
  if (b.length === 1 && b[0] === "") b.push("");
  return a.length === b.length && a.every((seg, i) => seg.startsWith(":") ? b[i] !== "" : seg === b[i]);
}

/** Policy for a request path relative to /api, or undefined if unlisted. Exact paths win over :params. */
export function accessFor(method: string, path: string): Access | undefined {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const candidates = API_POLICY.filter((p) => p.method === m && matches(p.path, path));
  candidates.sort((x, y) => x.path.split(":").length - y.path.split(":").length);
  return candidates[0]?.access;
}

export function isPublic(method: string, path: string): boolean {
  return accessFor(method, path) === "public";
}

/** Mounted on /api after authentication. Deny by default. */
export function enforceApiPolicy(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (req.method === "OPTIONS") {
    next(); // CORS preflight carries no credentials
    return;
  }
  const access = accessFor(req.method, req.path);
  if (access === undefined) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (access === "public") {
    next();
    return;
  }
  if (!req.auth) {
    res.status(401).json({ error: "Sign-in required" });
    return;
  }
  if (!roleSatisfies(req.auth.role, access)) {
    res.status(403).json({ error: `Requires ${access} role` });
    return;
  }
  next();
}
