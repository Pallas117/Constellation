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

export type AuthRole = "viewer" | "operator" | "admin";

export interface AuthContext {
  userId: string;
  email: string | null;
  role: AuthRole;
  rawRoles: string[];
  token: string;
}

export type AuthenticatedRequest = Request & { auth?: AuthContext };

const ROLE_RANK: Record<AuthRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
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
  if (normalized === "viewer" || normalized === "operator" || normalized === "admin") {
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
    roles.add("viewer");
  }

  return Array.from(roles);
}

function highestRole(rawRoles: string[]): AuthRole {
  let current: AuthRole = "viewer";
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
 * `npm run auth:set-role`). Anything missing or unknown is a viewer.
 */
export function roleFromUser(user: { role?: unknown } | null | undefined): AuthRole {
  return normalizeRole(user?.role) ?? "viewer";
}

export async function authenticateRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!authRequired()) {
    req.auth = {
      userId: "development",
      email: null,
      role: "admin",
      rawRoles: ["admin"],
      token: "dev-bypass",
    };
    next();
    return;
  }

  // 1. Try better-auth session first
  try {
    const sessionResponse = await auth.api.getSession({
      headers: getWebHeaders(req)
    });
    
    if (sessionResponse && sessionResponse.session && sessionResponse.user) {
      req.auth = {
        userId: sessionResponse.user.id,
        email: sessionResponse.user.email ?? null,
        role: roleFromUser(sessionResponse.user),
        rawRoles: [roleFromUser(sessionResponse.user)],
        token: sessionResponse.session.token ?? "better-auth-session"
      };
      next();
      return;
    }
  } catch (err) {
    // Ignore internal auth errors; no legacy fallback is configured.
  }

  unauthorized(res, "Missing active better-auth session");
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
