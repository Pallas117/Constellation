import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { auth } from "./better-auth.js";
import { SessionIdle, sessionTokenFromCookie } from "./session-idle.js";

function getWebHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}

/**
 * Each role includes everything below it:
 * - user: the live visualisation and their own account (default for sign-ups)
 * - staff: plus Mesh onboarding — enroll their own devices onto the mesh
 * - operator: plus the operator console, team network status, protection research
 * - admin: plus managing roles and any device
 */
export type AuthRole = "user" | "staff" | "operator" | "admin";

export interface AuthContext {
  userId: string;
  email: string | null;
  role: AuthRole;
  rawRoles: string[];
  token: string;
}

/** `P` types `req.params`; pass the route's params, e.g. `AuthenticatedRequest<{ id: string }>` for "/:id". */
/** `sessionEnded`: this server ended the caller's session (idle sign-out); its 401 is not an attack (CyberTiger). */
export type AuthenticatedRequest<P = Request["params"]> = Request<P> & { auth?: AuthContext; sessionEnded?: boolean };

const ROLE_RANK: Record<AuthRole, number> = {
  user: 1,
  staff: 2,
  operator: 3,
  admin: 4,
};

function authRequired(): boolean {
  // The dev bypass grants admin to everyone, so it is never honoured in production.
  if (process.env.NODE_ENV === "production") return true;
  const value = (process.env.AUTH_REQUIRED ?? "true").toLowerCase();
  return value !== "false";
}

function normalizeRole(value: unknown): AuthRole | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.toLowerCase();
  if (normalized === "viewer") {
    return "user"; // legacy name from before staff/user existed
  }
  if (normalized === "user" || normalized === "staff" || normalized === "operator" || normalized === "admin") {
    return normalized;
  }
  return null;
}

function extractRoles(user: {
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
}): string[] {
  const roles = new Set<string>();

  const appRole = normalizeRole(user.app_metadata?.role);
  if (appRole) roles.add(appRole);

  const appRoles = user.app_metadata?.roles;
  if (Array.isArray(appRoles)) {
    for (const role of appRoles) {
      const mapped = normalizeRole(role);
      if (mapped) roles.add(mapped);
    }
  }

  const userRole = normalizeRole(user.user_metadata?.role);
  if (userRole) roles.add(userRole);

  if (roles.size === 0) {
    roles.add("user");
  }

  return Array.from(roles);
}

function highestRole(rawRoles: string[]): AuthRole {
  let current: AuthRole = "user";
  for (const role of rawRoles) {
    const mapped = normalizeRole(role);
    if (!mapped) continue;
    if (ROLE_RANK[mapped] > ROLE_RANK[current]) {
      current = mapped;
    }
  }
  return current;
}

function unauthorized(res: Response, message: string): void {
  res.status(401).json({ error: message });
}

function forbidden(res: Response, message: string): void {
  res.status(403).json({ error: message });
}

/**
 * Role comes from the better-auth user record (`role` column, set only by
 * `npm run auth:set-role`). Anything missing or unknown is a user.
 */
export function roleFromUser(user: { role?: unknown } | null | undefined): AuthRole {
  return normalizeRole(user?.role) ?? "user";
}

/** Operator and admin sessions end after 30 minutes without a request (backend/session-idle.ts). */
export const sessionIdle = new SessionIdle();

const DEV_BYPASS: AuthContext = { userId: "development", email: null, role: "admin", rawRoles: ["admin"], token: "dev-bypass" };

/**
 * The caller's identity from the better-auth session, or null. `ended` is true when this server signed that session
 * out (idle), so callers can say so and CyberTiger doesn't count the 401 as an attack.
 */
async function resolveSession(headers: Headers): Promise<{ context: AuthContext | null; ended: boolean }> {
  if (!authRequired()) return { context: { ...DEV_BYPASS, rawRoles: ["admin"] }, ended: false };
  try {
    const sessionResponse = await auth.api.getSession({ headers });
    if (sessionResponse && sessionResponse.session && sessionResponse.user) {
      const role = roleFromUser(sessionResponse.user);
      const token = sessionResponse.session.token;
      if (token) {
        // Ended here before (and the revoke didn't take, or this is a replay of the old cookie): still ended.
        if (sessionIdle.wasEnded(token)) return { context: null, ended: true };
        if (ROLE_RANK[role] >= ROLE_RANK.operator && sessionIdle.touch(token) === "idle") {
          sessionIdle.end(token);
          try {
            await auth.api.revokeSession({ headers, body: { token } });
          } catch {
            // The ended mark above already refuses it; the row expires on its own.
          }
          return { context: null, ended: true };
        }
      }
      return {
        context: {
          userId: sessionResponse.user.id,
          email: sessionResponse.user.email ?? null,
          role,
          rawRoles: [role],
          token: token ?? "better-auth-session",
        },
        ended: false,
      };
    }
  } catch {
    // Ignore internal auth errors; no legacy fallback is configured.
  }
  return { context: null, ended: sessionIdle.wasEnded(sessionTokenFromCookie(headers.get("cookie"))) };
}

async function sessionContext(req: AuthenticatedRequest): Promise<AuthContext | null> {
  const { context, ended } = await resolveSession(getWebHeaders(req));
  if (ended) req.sessionEnded = true;
  return context;
}

export async function authenticateRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const context = await sessionContext(req);
  if (!context) {
    if (req.sessionEnded) {
      // Tells the app to show the sign-in page rather than retry.
      res.setHeader("x-gauss-session", "ended");
      unauthorized(res, `Signed out after ${sessionIdle.idleMinutes} minutes without activity. Please sign in again.`);
      return;
    }
    unauthorized(res, "Missing active better-auth session");
    return;
  }
  req.auth = context;
  next();
}

/**
 * For public, read-only endpoints (the landing visualisation): attaches the
 * session if there is one, but never rejects. Anonymous visitors must not get
 * 401s there — CyberTiger counts each as an auth failure and blocks the IP.
 */
export async function authenticateOptional(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  req.auth = (await sessionContext(req)) ?? undefined;
  next();
}

export function requireRole(minRole: AuthRole) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const role = req.auth?.role;
    if (!role) {
      unauthorized(res, "Missing auth context");
      return;
    }
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
      forbidden(res, `Requires ${minRole} role`);
      return;
    }
    next();
  };
}

export async function authenticateSocket(req: IncomingMessage): Promise<AuthContext | null> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return (await resolveSession(headers)).context;
}

export function roleSatisfies(current: AuthRole, required: AuthRole): boolean {
  return ROLE_RANK[current] >= ROLE_RANK[required];
}
