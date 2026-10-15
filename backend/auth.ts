import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { auth } from "./better-auth.js";

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

export type AuthenticatedRequest = Request & { auth?: AuthContext };

const ROLE_RANK: Record<AuthRole, number> = {
  user: 1,
  staff: 2,
  operator: 3,
  admin: 4,
};

function authRequired(): boolean {
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

/** Resolves the caller's identity from the better-auth session, or null. */
async function sessionContext(req: AuthenticatedRequest): Promise<AuthContext | null> {
  if (!authRequired()) {
    return {
      userId: "development",
      email: null,
      role: "admin",
      rawRoles: ["admin"],
      token: "dev-bypass",
    };
  }
  try {
    const sessionResponse = await auth.api.getSession({
      headers: getWebHeaders(req)
    });
    if (sessionResponse && sessionResponse.session && sessionResponse.user) {
      return {
        userId: sessionResponse.user.id,
        email: sessionResponse.user.email ?? null,
        role: roleFromUser(sessionResponse.user),
        rawRoles: [roleFromUser(sessionResponse.user)],
        token: sessionResponse.session.token ?? "better-auth-session"
      };
    }
  } catch (err) {
    // Ignore internal auth errors; no legacy fallback is configured.
  }
  return null;
}

export async function authenticateRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const context = await sessionContext(req);
  if (!context) {
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
  if (!authRequired()) {
    return {
      userId: "development",
      email: null,
      role: "admin",
      rawRoles: ["admin"],
      token: "dev-bypass",
    };
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }

  try {
    const sessionResponse = await auth.api.getSession({ headers });
    if (sessionResponse && sessionResponse.session && sessionResponse.user) {
      return {
        userId: sessionResponse.user.id,
        email: sessionResponse.user.email ?? null,
        role: roleFromUser(sessionResponse.user),
        rawRoles: [roleFromUser(sessionResponse.user)],
        token: sessionResponse.session.token ?? "better-auth-session",
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function roleSatisfies(current: AuthRole, required: AuthRole): boolean {
  return ROLE_RANK[current] >= ROLE_RANK[required];
}
