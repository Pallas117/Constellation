import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { getSupabaseAdminClient } from "./supabase.js";
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

function parseAuthorization(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return trimmed.slice(7).trim() || null;
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

export function getTokenFromRequest(req: Request): string | null {
  const authHeader = parseAuthorization(req.header("authorization") ?? undefined);
  if (authHeader) {
    return authHeader;
  }
  const queryToken = typeof req.query.token === "string" ? req.query.token.trim() : "";
  return queryToken || null;
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
        role: "admin", // Skunkworks operators get full visualization clearance
        rawRoles: ["admin"],
        token: sessionResponse.session.token ?? "better-auth-session"
      };
      next();
      return;
    }
  } catch (err) {
    // Ignore internal auth errors, proceed to Supabase fallback
  }

  // 2. Fallback to Supabase bearer token
  const token = getTokenFromRequest(req);
  if (!token) {
    unauthorized(res, "Missing bearer token or active session");
    return;
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    res.status(500).json({ error: "Supabase admin credentials not configured" });
    return;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    unauthorized(res, "Invalid or expired token");
    return;
  }

  const roles = extractRoles(data.user);
  req.auth = {
    userId: data.user.id,
    email: data.user.email ?? null,
    role: highestRole(roles),
    rawRoles: roles,
    token,
  };

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

  let token: string | null = null;
  const url = req.url ? new URL(req.url, "http://localhost") : null;
  if (url) {
    const qToken = url.searchParams.get("token");
    if (qToken && qToken.trim()) {
      token = qToken.trim();
    }
  }

  if (!token) {
    const authHeader = parseAuthorization(
      typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    );
    if (authHeader) {
      token = authHeader;
    }
  }

  if (!token) {
    return null;
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return null;
  }

  const roles = extractRoles(data.user);
  return {
    userId: data.user.id,
    email: data.user.email ?? null,
    role: highestRole(roles),
    rawRoles: roles,
    token,
  };
}

export function roleSatisfies(current: AuthRole, required: AuthRole): boolean {
  return ROLE_RANK[current] >= ROLE_RANK[required];
}
