// Client for organisation self-service (/api/orgs) and the public pilot form.
// Session cookies are attached by lib/api/backend-credentials.

export const BACKEND_URL = import.meta.env.VITE_HELIO_PROXY_URL ?? "http://127.0.0.1:3001";

export type Plan = "free" | "pilot" | "enterprise";

export interface PlanLimits {
  api: boolean;
  requestsPerMinute: number;
  requestsPerDay: number;
  maxLookbackMs: number;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Org {
  id: string;
  name: string;
  plan: Plan;
  limits: PlanLimits;
  keys: ApiKeyInfo[];
}

export interface Usage {
  from: string;
  to: string;
  total: number;
  rows: Array<{ day: string; keyId: string; endpoint: string; count: number }>;
}

export type PilotInterest = "data-api" | "connectivity" | "both";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BACKEND_URL}/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const commerceApi = {
  myOrgs: () => call<{ orgs: Org[] }>("/orgs/mine").then((r) => r.orgs),
  createKey: (orgId: string, name: string) =>
    call<{ key: string; info: ApiKeyInfo }>(`/orgs/${encodeURIComponent(orgId)}/keys`, { method: "POST", body: JSON.stringify({ name }) }),
  revokeKey: (orgId: string, keyId: string) =>
    call<void>(`/orgs/${encodeURIComponent(orgId)}/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" }),
  usage: (orgId: string) => call<Usage>(`/orgs/${encodeURIComponent(orgId)}/usage`),
  requestPilot: (body: { name: string; email: string; company: string; interest: PilotInterest; useCase: string; website: string }) =>
    call<{ ok: true }>("/pilot-requests", { method: "POST", body: JSON.stringify(body) }),
};
