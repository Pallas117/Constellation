/**
 * The evidence pack `trust:ingest --pack` would write for the synthetic fixture log (not customer
 * data), built from the stored inputs, and helpers that rewrite a pack the way a forger would
 * (recomputing every hash). Shared by the evidence-pack and signing tests.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadArchive, replayArchive } from "../../replay/replay.js";
import type { CanonicalSpaceWeatherPoint } from "../../types.js";
import { EnvironmentHistory } from "../environment.js";
import { buildEvidencePack, GENESIS, packHashOf, type EvidenceInputs, type EvidencePack } from "../evidence.js";
import { ingestLog, type LogMapping } from "../ingest.js";
import { buildTrustRecord, canonicalJson, DEFAULT_POLICY, TRUST_RECORD_SCHEMA, type TrustRecord } from "../record.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
// A synthetic log (not customer data): rows 1, 2 and 6 accepted, the other six rejected with reasons.
export const csv = readFileSync(here("generic-inferences.csv"));
export const mapping = JSON.parse(readFileSync(here("../mappings/generic-csv.json"), "utf8")) as LogMapping;
export const archivePath = here("../../replay/events/jan-2026.json.gz");
export const WINDOW = { from: "2026-01-19T00:00:00Z", to: "2026-01-19T06:00:00Z" };
export const NOW = Date.parse("2026-01-20T02:00:00Z");

let history: EnvironmentHistory | null = null;
export async function replayed(): Promise<EnvironmentHistory> {
  if (!history) {
    const points: CanonicalSpaceWeatherPoint[] = [];
    await replayArchive(loadArchive(archivePath), { end: "2026-01-19T05:30:00Z", points });
    history = new EnvironmentHistory(points, "replay jan-2026");
  }
  return history;
}

/** The pack trust:ingest --pack would write for the fixture log, built from the stored inputs. */
export async function packFromStoredInputs(previousPackHash: string | null = null): Promise<{ pack: EvidencePack; records: TrustRecord[]; inputs: EvidenceInputs }> {
  const report = ingestLog(csv, mapping);
  const h = await replayed();
  const records = report.accepted.map((a) => buildTrustRecord(a.request, h, { nowMs: NOW, policy: DEFAULT_POLICY }));
  const inputs: EvidenceInputs = {
    log: { fileSha256: report.file.sha256, bytes: report.file.bytes, rows: report.file.rows, mappingId: report.mapping.id, mappingVersion: report.mapping.version, rejected: report.rejected },
    environment: { source: h.label, archiveSha256: sha(readFileSync(archivePath)) },
    policy: DEFAULT_POLICY,
    software: { name: "Gauss", commit: "test", requirementsVersion: "test", trustRecordSchema: TRUST_RECORD_SCHEMA },
    previousPackHash,
  };
  return { pack: buildEvidencePack([...records].reverse(), { window: WINDOW, generatedAtMs: NOW, inputs }), records, inputs };
}

export const clone = (p: EvidencePack): EvidencePack => JSON.parse(JSON.stringify(p)) as EvidencePack;
export const rehashRecord = (r: TrustRecord) => {
  const { hash: _h, ...rest } = r;
  r.hash = sha(canonicalJson(rest));
};
export const relink = (p: EvidencePack) => {
  let prev = p.inputs.previousPackHash ?? GENESIS;
  p.chain.links = p.records.map((r) => {
    prev = sha(prev + r.hash);
    return { recordId: r.recordId, recordHash: r.hash, link: prev };
  });
  p.chain.head = prev;
};
export const rehashPack = (p: EvidencePack) => {
  p.packHash = packHashOf(p);
};
