/**
 * Deterministic ids and checksums for world records (GAU-39).
 *
 * The checksum is SHA-256 over the record's canonical JSON (keys sorted, `id`/`checksum` excluded);
 * the id is `<prefix>_<first 16 hex>`. Same content → same id on every run and machine, so replays
 * are comparable and tampering is detectable.
 */
import { createHash } from "node:crypto";
import { WorldRecord } from "./contracts.js";

/** JSON with object keys sorted recursively; numbers and strings as JSON.stringify writes them. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const PREFIX = {
  observation: "obs", state: "st", delta: "dl", event: "ev", action: "ac", transition: "tr", hypothesis: "hy",
} as const;

type Kind = keyof typeof PREFIX;

/** Seal a record body: add its checksum and deterministic id. */
export function seal<T extends { kind: Kind }>(body: T): T & { id: string; checksum: string } {
  const { id: _id, checksum: _c, ...content } = body as T & { id?: string; checksum?: string };
  const checksum = createHash("sha256").update(canonicalJson(content)).digest("hex");
  return { ...(content as T), id: `${PREFIX[body.kind]}_${checksum.slice(0, 16)}`, checksum };
}

/** Schema-valid, and its id and checksum match its content. Returns the problems found. */
export function verifyRecord(record: unknown): string[] {
  const parsed = WorldRecord.safeParse(record);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`);
  const resealed = seal(parsed.data as Parameters<typeof seal>[0]);
  const problems: string[] = [];
  if (resealed.checksum !== parsed.data.checksum) problems.push("checksum does not match content");
  if (resealed.id !== parsed.data.id) problems.push("id does not match content");
  return problems;
}
