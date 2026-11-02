import type { NextFunction, Response } from "express";
import { roleSatisfies, type AuthenticatedRequest, type AuthRole } from "./auth.js";
import { stepUpFresh } from "./passkey-policy.js";

/**
 * The single source of truth for who may call which API route.
 *
 * - "public": no session needed (the open landing visualisation)
 * - a role: that role or higher (user < staff < operator < admin)
 * - stepUp: also needs a passkey touch in the last 5 minutes (GAU-235). The
 *   answer otherwise is 428 STEP_UP_REQUIRED, not 401/403, so a stale touch
 *   never counts toward CyberTiger's auth-failure block; the console asks for
 *   Touch ID or Face ID and retries.
 *
 * Every /api route must appear here; anything unlisted is denied
 * (backend/rbac.test.ts fails if a route is added without a policy).
 * Routers may add finer checks on top, e.g. device ownership.
 * Not listed because they never reach this middleware: /api/auth/* (better-auth),
 * /api/sso-options (public, registered first), the Argo device-token routes
 * (POST /api/mesh/report, /api/mesh/bundles*, GET /api/mesh/directory,
 * POST /api/mesh/keys; backend/mesh/router.ts) and /api/v1/* (organisation API keys; plan, quota and
 * metering in backend/commerce/), all registered before session auth.
 */
export type Access = "public" | AuthRole;

export interface Policy {
  method: string;
  path: string;
  access: Access;
  stepUp?: true;
}

export const STEP_UP_REQUIRED = "STEP_UP_REQUIRED";

export const API_POLICY: ReadonlyArray<Policy> = [
  // Open landing visualisation
  { method: "GET", path: "/feed/space-weather/latest", access: "public" },
  { method: "GET", path: "/system/connectivity", access: "public" },
  { method: "POST", path: "/pilot-requests", access: "public" }, // landing "Request a pilot" form

  // Free account (user): richer feeds behind sign-in
  { method: "GET", path: "/feed/space-weather/5s", access: "user" },
  { method: "GET", path: "/feed/space-weather/latest/proto", access: "user" },
  { method: "GET", path: "/feed/space-objects", access: "user" },
  { method: "GET", path: "/feed/aurora/map", access: "user" },
  { method: "GET", path: "/feed/mms/reconnection", access: "user" },
  { method: "GET", path: "/feed/mms/reconnection/latest", access: "user" },
  { method: "GET", path: "/feed/sources/status", access: "user" },
  { method: "GET", path: "/world/state", access: "user" }, // typed world state, read-only (GAU-39)
  { method: "GET", path: "/system/pipeline", access: "user" }, // operator-view data-flow HUD (GAU-110)
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

  // Organisation self-service; the router checks membership (operators may read usage)
  { method: "GET", path: "/orgs/mine", access: "user" },
  { method: "POST", path: "/orgs/:orgId/keys", access: "user" },
  { method: "DELETE", path: "/orgs/:orgId/keys/:keyId", access: "user" },
  { method: "GET", path: "/orgs/:orgId/usage", access: "user" },

  // Operators: console tools
  { method: "GET", path: "/rag/status", access: "operator" },
  { method: "POST", path: "/rag/query", access: "operator" },
  { method: "GET", path: "/security/cybertiger/status", access: "operator" },
  { method: "GET", path: "/system/tpm", access: "operator" }, // TPM values (GAU-122); /health has the public summary
  { method: "GET", path: "/swx/structures", access: "operator" }, // L1 structure candidates (GAU-154)
  { method: "POST", path: "/ai/nowcast/infer", access: "operator" },
  { method: "GET", path: "/device/swap/plan", access: "operator" },
  { method: "POST", path: "/device/swap/rebalance", access: "operator" },
  { method: "POST", path: "/device/:id/quality", access: "operator" },

  // Admins: security controls, roles and model training. Changes need a fresh passkey touch.
  { method: "GET", path: "/security/cybertiger/events", access: "admin" },
  { method: "POST", path: "/security/cybertiger/block", access: "admin", stepUp: true },
  { method: "POST", path: "/security/cybertiger/unblock", access: "admin", stepUp: true },
  { method: "POST", path: "/ai/nowcast/train", access: "admin", stepUp: true },
  { method: "GET", path: "/admin/users", access: "admin" },
  { method: "POST", path: "/admin/users/:id/role", access: "admin", stepUp: true },
];

function matches(pattern: string, path: string): boolean {
  const a = pattern.split("/");
  const b = path.replace(/\/+$/, "").split("/");
  if (b.length === 1 && b[0] === "") b.push("");
  return a.length === b.length && a.every((seg, i) => seg.startsWith(":") ? b[i] !== "" : seg === b[i]);
}

/** Policy entry for a request path relative to /api, or undefined if unlisted. Exact paths win over :params. */
export function policyFor(method: string, path: string): Policy | undefined {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const candidates = API_POLICY.filter((p) => p.method === m && matches(p.path, path));
  candidates.sort((x, y) => x.path.split(":").length - y.path.split(":").length);
  return candidates[0];
}

export function accessFor(method: string, path: string): Access | undefined {
  return policyFor(method, path)?.access;
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
  const policy = policyFor(req.method, req.path);
  const access = policy?.access;
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
  if (policy?.stepUp && !stepUpFresh(req.auth.passkeyAt)) {
    res.status(428).json({ error: "Confirm with your passkey (Touch ID or Face ID) first.", code: STEP_UP_REQUIRED });
    return;
  }
  next();
}
