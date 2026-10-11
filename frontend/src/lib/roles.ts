// Mirrors backend/auth.ts: each role includes everything below it.
export type Role = "user" | "staff" | "operator" | "admin";

const RANK: Record<Role, number> = { user: 1, staff: 2, operator: 3, admin: 4 };

/** `role` is a server-side field the auth client's user type doesn't declare. */
export function roleOf(user: unknown): Role {
  const raw = (user as { role?: unknown } | null | undefined)?.role;
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  if (value === "viewer") return "user";
  return value in RANK ? (value as Role) : "user";
}

export function hasRole(role: Role, required: Role): boolean {
  return RANK[role] >= RANK[required];
}

/** Where each role starts after signing in. */
export function landingFor(role: Role): string {
  if (hasRole(role, "operator")) return "/operator";
  if (hasRole(role, "staff")) return "/mesh";
  return "/";
}
