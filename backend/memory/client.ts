// Client for the Gauss memory service ("Cosmic Brain", private repo gauss-brain): a
// localhost sidecar that returns checksum-verified evidence from an approved corpus.
// It has no authentication of its own, so only a loopback URL is ever used, and this
// backend's role policy (rbac.ts) is the gate. Which corpus it serves (public, member or
// operator catalog) is decided by how that process is started, never by this client.

export const MEMORY_TIMEOUT_MS = 15_000;
export const MAX_QUERY_CHARS = 2_000;
const DEFAULT_URL = "http://127.0.0.1:3002";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface MemorySource {
  filePath: string;
  chunkId: string;
  score: number;
  sourceSha256: string | null;
  verified: boolean;
}

export type MemoryStatus =
  | {
      available: true;
      state: "nominal" | "unknown";
      documents: number;
      chunks: number;
      nodes: number;
      edges: number;
      lastIndexAt: string | null;
    }
  | { available: false; reason: string };

export type MemoryAnswer =
  | { available: true; answer: string; sources: MemorySource[] }
  | { available: false; reason: string };

/** The service origin, or null when unset, "off", or not a loopback http URL. */
export function memoryBaseUrl(raw: string | undefined = process.env.GAUSS_MEMORY_URL): string | null {
  const value = (raw ?? DEFAULT_URL).trim();
  if (!value || value === "off") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.username || url.password) return null;
  return url.origin;
}

/** Corpus paths are shown to users: keep relative paths, reduce absolute ones to the file name. */
export function displayPath(filePath: unknown): string {
  if (typeof filePath !== "string" || !filePath) return "unknown source";
  const isAbsolute = filePath.startsWith("/") || filePath.startsWith("~") || /^[A-Za-z]:[\\/]/.test(filePath);
  if (!isAbsolute && !filePath.split(/[\\/]/).includes("..")) return filePath;
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? "unknown source";
}

const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The service reports index time as epoch seconds (or, from older builds, an ISO string). */
function isoTime(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

async function call(path: string, init?: RequestInit): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  const base = memoryBaseUrl();
  if (!base) return { ok: false, reason: "Memory service not configured (GAUSS_MEMORY_URL must be a loopback http URL)." };
  try {
    const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(MEMORY_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, reason: `Memory service error ${response.status}.` };
    return { ok: true, body: await response.json() };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { ok: false, reason: timedOut ? "Memory service timed out." : "Memory service unreachable." };
  }
}

export async function memoryStatus(): Promise<MemoryStatus> {
  const result = await call("/api/rag/status");
  if (!result.ok) return { available: false, reason: result.reason };
  const b = result.body as Record<string, unknown>;
  // Only counts and freshness leave this process; the service also reports local paths.
  return {
    available: true,
    state: b.state === "nominal" ? "nominal" : "unknown",
    documents: finite(b.documents),
    chunks: finite(b.chunks),
    nodes: finite(b.nodes),
    edges: finite(b.edges),
    lastIndexAt: isoTime(b.lastIndexAt),
  };
}

/** Asks the service; its answer abstains ("Unknown/insufficient evidence") when nothing verified matches. */
export async function memoryQuery(query: string, topK = 8): Promise<MemoryAnswer> {
  const result = await call("/api/rag/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query.slice(0, MAX_QUERY_CHARS), top_k: Math.max(1, Math.min(20, Math.trunc(topK))) }),
  });
  if (!result.ok) return { available: false, reason: result.reason };
  const b = result.body as { answer?: unknown; sources?: unknown };
  if (typeof b.answer !== "string") return { available: false, reason: "Memory service returned no answer." };
  const sources = Array.isArray(b.sources) ? b.sources : [];
  return {
    available: true,
    answer: b.answer,
    sources: sources
      .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
      .filter((s) => s.verified === true)
      .map((s) => ({
        filePath: displayPath(s.filePath),
        chunkId: typeof s.chunkId === "string" ? s.chunkId : "",
        score: finite(s.score),
        sourceSha256: typeof s.sourceSha256 === "string" ? s.sourceSha256 : null,
        verified: true,
      })),
  };
}
