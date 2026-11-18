import { apiBase } from "./base-url";
import { describeHttpFailure } from "./http-error";
// Client for the operator console's Evidence view (/api/trust/evidence, operators and above;
// backend/trust/evidence-router.ts). Nothing here polls: every call follows a click.
// Session cookies are attached by lib/api/backend-credentials.

/** A value Gauss held for the inference time; null when unknown. */
interface Field<T> {
  value: T | null;
}

export interface TrustRecord {
  recordId: string;
  inference: { time: string; spacecraftId: string; modelId: string; confidence: number | null; ingest: { row: number } | null };
  environment: { radiation: Field<{ label: string }>; geomagnetic: Field<{ label: string }>; kp: Field<{ value: number }> };
  orbit: { saa: Field<boolean> };
  verdict: { value: "consistent" | "degraded-context" | "unknown"; reasons: string[] };
  hash: string;
}

export interface EvidencePack {
  schema: string;
  packId: string;
  window: { from: string; to: string };
  generatedAt: string;
  inputs: {
    log: { fileSha256: string; rows: number; mappingId: string; mappingVersion: string; rejected: Array<{ row: number; errors: string[] }> } | null;
    environment: { source: string };
    software: { commit: string; requirementsVersion: string };
  };
  summary: { records: number; verdicts: Record<string, number> };
  chain: { head: string };
  records: TrustRecord[];
  limitations: string[];
  signature: { keyId: string; signedAt: string } | null;
  packHash: string;
}

export interface LogMapping {
  id: string;
  version: string;
  format: string;
}

export interface EvidenceOptions {
  events: Array<{ id: string; title: string | null; start: string | null; end: string | null }>;
  mappings: LogMapping[];
  /** A synthetic log (no customer data). */
  sample: { name: string; mappingId: string; eventId: string; text: string };
  maxLogBytes: number;
  keys: Array<{ keyId: string; purposes: string[]; status: string }>;
  keyring: string;
  signOnHost: string;
}

export interface Analysis {
  summary: {
    file: { sha256: string; bytes: number; rows: number };
    mapping: { id: string; version: string };
    accepted: number;
    rejected: Array<{ row: number; errors: string[] }>;
    verdicts: Record<string, number>;
  };
  records: TrustRecord[];
  pack: EvidencePack;
  signed: boolean;
  signOnHost: string;
}

export interface PackCheck {
  ok: boolean;
  problems: string[];
  notes: string[];
  /** What `npm run trust:verify` prints for this pack. */
  lines: string[];
  keyring: string;
}

async function send(path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${apiBase()}/api/trust/evidence${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const failure = (await res.json().catch(() => ({}))) as { error?: string; problems?: string[] };
    const why = failure.error ?? describeHttpFailure("Request failed", res.status);
    throw new Error(failure.problems?.length ? `${why}: ${failure.problems.join("; ")}` : why);
  }
  return res;
}

/** The bytes `trust:ingest --pack` writes: a pack downloaded here is the same file the CLI makes. */
export const packFileText = (pack: unknown) => JSON.stringify(pack, null, 2) + "\n";

export const evidenceApi = {
  options: async () => (await (await send("/options")).json()) as EvidenceOptions,
  analyse: async (body: { log: string; eventId: string; mappingId?: string; mapping?: unknown }) => (await (await send("/analyse", body)).json()) as Analysis,
  verify: async (pack: unknown, name: string, allowUnsigned: boolean) => (await (await send("/verify", { pack, name, allowUnsigned })).json()) as PackCheck,
  pdf: async (pack: unknown) => (await send("/pdf", { pack })).blob(),
};
