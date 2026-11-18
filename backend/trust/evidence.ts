/**
 * Evidence packs (PR-04, GAU-60): one report per analysis window for customer QA and for
 * insurer or regulator conversations. It holds the trust records, the inputs they were built
 * from (log and replay-archive hashes, mapping, policy, software version), every log row that
 * was not used and why, a verdict summary and the limitations.
 *
 * Integrity: records are sorted and hash-chained (link = SHA-256 of the previous link and the
 * record's own hash, starting from the previous pack's hash when there is one), and the pack
 * hash covers everything but the signature. Authorship: an Ed25519 signature over the pack hash
 * and chain head (GAU-67, `signing.ts`) shows which Gauss key made the pack, so a customer
 * needs only the published keyring, not a trusted copy of the hash. The same stored inputs and
 * code give the same pack hash and unsigned pack, byte for byte; signing adds the signing time.
 *
 * Wording is enforced, not just intended: the limitations always state that this is the
 * environment, not the spacecraft; Gauss-authored text may not use the trust record's banned
 * words, make a regulatory claim, or say the spacecraft experienced something.
 */
import { createHash } from "node:crypto";
import type { PackSignature } from "./signing.js";
import {
  canonicalJson,
  RECORD_LIMITATIONS,
  TRUST_RECORD_SCHEMA,
  wordingHits,
  type TrustPolicy,
  type TrustRecord,
  type Verdict,
} from "./record.js";

export const EVIDENCE_PACK_SCHEMA = "gauss.evidence-pack/0.1";
/** The chain's start when there is no previous pack. */
export const GENESIS = "0".repeat(64);

export const ENVIRONMENT_NOT_SPACECRAFT =
  "Environment, not spacecraft: this pack describes the space environment when each inference ran, from public monitors and models. Nothing in it was measured on the spacecraft, and it says nothing about the spacecraft's hardware or whether any output was right.";
export const PACK_LIMITATIONS = [
  ENVIRONMENT_NOT_SPACECRAFT,
  "Advisory only: Gauss has no telecommand authority over any spacecraft.",
  "No regulatory or compliance claim is made.",
  "Integrity and authorship: the hashes show whether the pack changed after it was made. A valid signature from a key in the published Gauss keyring shows that Gauss made it; an unsigned pack shows integrity only, given a trusted copy of the pack hash.",
];

/** Regulatory claims a pack must not make without written advice from counsel. */
const REGULATORY = /\b(EU AI Act|AI Act|conform(?:s|ant|ity)? (?:to|with)|in compliance with|meets the requirements of|accredited|approved by)\b/i;
/** Wording that puts the measurement at the spacecraft. */
const AT_SPACECRAFT =
  /\b(?:spacecraft|satellite|payload|processor|hardware)\s+(?:experienced|received|absorbed|was exposed to|was irradiated|was hit|suffered)\b/i;

export interface LogInput {
  fileSha256: string;
  bytes: number;
  /** Data rows in the file; every one is either a record in this pack or listed in `rejected`. */
  rows: number;
  mappingId: string;
  mappingVersion: string;
  rejected: Array<{ row: number; errors: string[] }>;
}

export interface EvidenceInputs {
  /** The customer log the inferences came from; null when the requests came another way. */
  log: LogInput | null;
  /** The environment history, and the SHA-256 of the stored archive it was replayed from (null for the live feed). */
  environment: { source: string; archiveSha256: string | null };
  policy: TrustPolicy;
  software: { name: string; commit: string; requirementsVersion: string; trustRecordSchema: string };
  /** Pack hash of the previous pack in this series; the chain starts from it. */
  previousPackHash: string | null;
}

export interface ChainLink {
  recordId: string;
  recordHash: string;
  /** SHA-256 of `prev` and `recordHash` (hex strings, concatenated). */
  link: string;
}

export interface EvidencePack {
  schema: typeof EVIDENCE_PACK_SCHEMA;
  packId: string;
  window: { from: string; to: string };
  generatedAt: string;
  inputs: EvidenceInputs;
  scope: { spacecraft: string[]; models: string[]; processorProfiles: string[] };
  summary: {
    records: number;
    verdicts: Record<Verdict, number>;
    bySpacecraft: Array<{ spacecraftId: string; verdicts: Record<Verdict, number> }>;
    /** Verdict reasons by kind (the text before any detail), most frequent first. */
    reasons: Array<{ reason: string; count: number }>;
  };
  chain: { head: string; links: ChainLink[] };
  records: TrustRecord[];
  limitations: string[];
  /** Ed25519 signature over the pack hash and chain head (GAU-67), or null when unsigned. */
  signature: PackSignature | null;
  /** SHA-256 of the canonical pack without this field and with `signature` null, so signing or re-signing never changes it. */
  packHash: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** The pack hash recomputed from the pack's content (the signature is not part of it). */
export const packHashOf = ({ packHash: _packHash, ...rest }: EvidencePack) => sha256(canonicalJson({ ...rest, signature: null }));
const recordHashOf = ({ hash: _hash, ...rest }: TrustRecord) => sha256(canonicalJson(rest));
const linkOf = (prev: string, recordHash: string) => sha256(prev + recordHash);
const verdictCounts = (): Record<Verdict, number> => ({ consistent: 0, "degraded-context": 0, unknown: 0 });
const order = (a: TrustRecord, b: TrustRecord) =>
  a.inference.time.localeCompare(b.inference.time) ||
  a.inference.spacecraftId.localeCompare(b.inference.spacecraftId) ||
  a.inference.modelId.localeCompare(b.inference.modelId) ||
  a.recordId.localeCompare(b.recordId);

/** Scope and verdict summary of sorted records (the builder writes them; the verifier recomputes them). */
function summarise(sorted: TrustRecord[]): Pick<EvidencePack, "scope" | "summary"> {
  const verdicts = verdictCounts();
  const bySpacecraft = new Map<string, Record<Verdict, number>>();
  const reasons = new Map<string, number>();
  for (const r of sorted) {
    verdicts[r.verdict.value] += 1;
    const sc = bySpacecraft.get(r.inference.spacecraftId) ?? verdictCounts();
    sc[r.verdict.value] += 1;
    bySpacecraft.set(r.inference.spacecraftId, sc);
    for (const reason of r.verdict.reasons) {
      const kind = reason.split(/ \(|: /)[0];
      reasons.set(kind, (reasons.get(kind) ?? 0) + 1);
    }
  }
  const distinct = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => x !== null))].sort();
  return {
    scope: {
      spacecraft: distinct(sorted.map((r) => r.inference.spacecraftId)),
      models: distinct(sorted.map((r) => r.inference.modelId)),
      processorProfiles: distinct(sorted.map((r) => r.inference.processorProfileId)),
    },
    summary: {
      records: sorted.length,
      verdicts,
      bySpacecraft: [...bySpacecraft].sort(([a], [b]) => a.localeCompare(b)).map(([spacecraftId, v]) => ({ spacecraftId, verdicts: v })),
      reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    },
  };
}

/** Problems with the Gauss-authored wording of a pack (the customer's own output and ids are not scanned). */
export function packWording(pack: Pick<EvidencePack, "records" | "limitations" | "summary">): string[] {
  const authored = [pack.limitations, pack.summary.reasons, pack.records.map(({ inference: _i, ...r }) => r)];
  return [
    ...wordingHits(authored).map((w) => `banned word "${w}"`),
    ...wordingHits(authored, REGULATORY).map((w) => `regulatory claim "${w}"`),
    ...wordingHits(authored, AT_SPACECRAFT).map((w) => `puts the measurement at the spacecraft: "${w}"`),
  ];
}

export function buildEvidencePack(
  records: TrustRecord[],
  options: { window: { from: string; to: string }; generatedAtMs: number; inputs: EvidenceInputs },
): EvidencePack {
  const { window, inputs } = options;
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const problems: string[] = [];
  if (!(fromMs < toMs)) problems.push("the window needs ISO times with from before to");
  const sorted = [...records].sort(order);
  const outside = sorted.filter((r) => !(Date.parse(r.inference.time) >= fromMs && Date.parse(r.inference.time) <= toMs));
  if (outside.length) problems.push(`${outside.length} record(s) outside the window, e.g. ${outside[0].inference.time}`);
  const ids = new Set<string>();
  for (const r of sorted) {
    if (r.schema !== TRUST_RECORD_SCHEMA) problems.push(`record ${r.recordId} has schema ${r.schema}`);
    if (recordHashOf(r) !== r.hash) problems.push(`record ${r.recordId} does not match its hash`);
    if (ids.has(r.recordId)) problems.push(`record ${r.recordId} appears twice`);
    ids.add(r.recordId);
    if (r.environmentSource !== inputs.environment.source) problems.push(`record ${r.recordId} was judged against "${r.environmentSource}", not "${inputs.environment.source}"`);
    if (canonicalJson(r.verdict.policy) !== canonicalJson(inputs.policy)) problems.push(`record ${r.recordId} was judged under another policy`);
    if (inputs.log && r.inference.ingest?.fileSha256 !== inputs.log.fileSha256) problems.push(`record ${r.recordId} did not come from the log in this pack`);
  }
  if (inputs.log && sorted.length + inputs.log.rejected.length !== inputs.log.rows) {
    problems.push(`log rows not accounted for: ${inputs.log.rows} rows, ${sorted.length} records, ${inputs.log.rejected.length} rejected`);
  }
  if (problems.length) throw new Error(`Evidence pack not built: ${problems.join("; ")}`);

  let prev = inputs.previousPackHash ?? GENESIS;
  const links = sorted.map((r) => {
    prev = linkOf(prev, r.hash);
    return { recordId: r.recordId, recordHash: r.hash, link: prev };
  });

  // Limitations: the pack's own, then each distinct record-level and known-field limitation, in
  // record order. The record's first limitation is what ENVIRONMENT_NOT_SPACECRAFT says for the pack.
  const limitations = [...PACK_LIMITATIONS];
  const addLimitation = (l: string) => {
    if (!limitations.includes(l) && l !== RECORD_LIMITATIONS[0]) limitations.push(l);
  };
  for (const r of sorted) {
    r.limitations.forEach(addLimitation);
    for (const f of [...Object.values(r.environment), ...Object.values(r.orbit), r.upsetRisk]) {
      if (f.value !== null) f.limitations.forEach(addLimitation);
    }
  }

  const body: Omit<EvidencePack, "packHash" | "packId"> = {
    schema: EVIDENCE_PACK_SCHEMA,
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    generatedAt: new Date(options.generatedAtMs).toISOString(),
    inputs: { ...inputs, previousPackHash: inputs.previousPackHash ?? null },
    ...summarise(sorted),
    chain: { head: prev, links },
    records: sorted,
    limitations,
    signature: null,
  };
  const wording = packWording(body);
  if (wording.length) throw new Error(`Evidence pack not built: ${wording.join("; ")}`);
  const withId = { ...body, packId: `ep_${sha256(canonicalJson({ w: body.window, h: prev, g: body.generatedAt })).slice(0, 20)}` };
  return { ...withId, packHash: sha256(canonicalJson(withId)) };
}

/**
 * Every problem found in a pack; an empty list means it is intact and follows the wording rules.
 * Who made it is a separate check: `verifyPackSignature` in `signing.ts`.
 */
export function verifyEvidencePack(pack: EvidencePack): string[] {
  const problems: string[] = [];
  if (pack?.schema !== EVIDENCE_PACK_SCHEMA) return [`not an evidence pack (schema ${String(pack?.schema)})`];
  const records = Array.isArray(pack.records) ? pack.records : [];
  const links = Array.isArray(pack.chain?.links) ? pack.chain.links : [];
  records.forEach((r, i) => {
    if (recordHashOf(r) !== r.hash) problems.push(`record ${i + 1} (${r.recordId}) was changed: it no longer matches its hash`);
  });
  if (links.length !== records.length) problems.push(`the chain has ${links.length} links for ${records.length} records`);
  let prev = pack.inputs?.previousPackHash ?? GENESIS;
  for (let i = 0; i < Math.min(links.length, records.length); i += 1) {
    const l = links[i];
    if (l.recordId !== records[i].recordId || l.recordHash !== records[i].hash || l.link !== linkOf(prev, l.recordHash)) {
      problems.push(`the chain breaks at record ${i + 1} (${records[i].recordId})`);
      break;
    }
    prev = l.link;
  }
  if (problems.length === 0 && pack.chain.head !== prev) problems.push("the chain head does not match the last link");
  for (let i = 1; i < records.length; i += 1) {
    if (order(records[i - 1], records[i]) > 0) {
      problems.push(`records are out of order at ${i + 1}`);
      break;
    }
  }
  const log = pack.inputs?.log;
  if (log && records.length + log.rejected.length !== log.rows) problems.push(`log rows not accounted for: ${log.rows} rows, ${records.length} records, ${log.rejected.length} rejected`);
  if (canonicalJson(summarise(records)) !== canonicalJson({ scope: pack.scope, summary: pack.summary })) problems.push("the summary does not match the records");
  if (!pack.limitations?.includes(ENVIRONMENT_NOT_SPACECRAFT)) problems.push("the environment-not-spacecraft limitation is missing");
  problems.push(...packWording(pack));
  if (packHashOf(pack) !== pack.packHash) problems.push("the pack hash does not match the pack");
  return problems;
}
