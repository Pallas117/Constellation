import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadArchive, replayArchive } from "../replay/replay.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import { EnvironmentHistory } from "./environment.js";
import { buildEvidencePack, ENVIRONMENT_NOT_SPACECRAFT, GENESIS, verifyEvidencePack, type EvidenceInputs, type EvidencePack } from "./evidence.js";
import { renderEvidencePdf } from "./evidence-pdf.js";
import { ingestLog, type LogMapping } from "./ingest.js";
import { HELVETICA_BOLD_WIDTHS, HELVETICA_WIDTHS, textWidth, winAnsi, wrap } from "./pdf.js";
import { buildTrustRecord, canonicalJson, DEFAULT_POLICY, TRUST_RECORD_SCHEMA, type TrustRecord } from "./record.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
// A synthetic log (not customer data): rows 1, 2 and 6 accepted, the other six rejected with reasons.
const csv = readFileSync(here("fixtures/generic-inferences.csv"));
const mapping = JSON.parse(readFileSync(here("mappings/generic-csv.json"), "utf8")) as LogMapping;
const archivePath = here("../replay/events/jan-2026.json.gz");
const WINDOW = { from: "2026-01-19T00:00:00Z", to: "2026-01-19T06:00:00Z" };
const NOW = Date.parse("2026-01-20T02:00:00Z");

let history: EnvironmentHistory | null = null;
async function replayed(): Promise<EnvironmentHistory> {
  if (!history) {
    const points: CanonicalSpaceWeatherPoint[] = [];
    await replayArchive(loadArchive(archivePath), { end: "2026-01-19T05:30:00Z", points });
    history = new EnvironmentHistory(points, "replay jan-2026");
  }
  return history;
}

/** The pack trust:ingest --pack would write for the fixture log, built from the stored inputs. */
async function packFromStoredInputs(previousPackHash: string | null = null): Promise<{ pack: EvidencePack; records: TrustRecord[]; inputs: EvidenceInputs }> {
  const report = ingestLog(readFileSync(here("fixtures/generic-inferences.csv")), mapping);
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

const clone = (p: EvidencePack): EvidencePack => JSON.parse(JSON.stringify(p)) as EvidencePack;
const rehashRecord = (r: TrustRecord) => {
  const { hash: _h, ...rest } = r;
  r.hash = sha(canonicalJson(rest));
};
const relink = (p: EvidencePack) => {
  let prev = p.inputs.previousPackHash ?? GENESIS;
  p.chain.links = p.records.map((r) => {
    prev = sha(prev + r.hash);
    return { recordId: r.recordId, recordHash: r.hash, link: prev };
  });
  p.chain.head = prev;
};
const rehashPack = (p: EvidencePack) => {
  const { packHash: _h, ...rest } = p;
  p.packHash = sha(canonicalJson(rest));
};

test("evidence pack: from a log and a replayed storm, every row accounted for, and the same stored inputs give the same pack and PDF (GAU-60)", async () => {
  const a = await packFromStoredInputs();
  const b = await packFromStoredInputs();
  assert.deepEqual(verifyEvidencePack(a.pack), []);
  assert.equal(a.pack.packHash, b.pack.packHash);
  assert.ok(renderEvidencePdf(a.pack).equals(renderEvidencePdf(b.pack)), "PDF identical byte for byte");
  assert.equal(a.pack.inputs.log?.fileSha256, sha(csv), "the log is identified by its hash");
  assert.equal(a.pack.inputs.environment.archiveSha256, sha(readFileSync(archivePath)), "and so is the replayed archive");
  assert.deepEqual(a.pack.records.map((r) => r.inference.ingest?.row), [1, 2, 6], "sorted by time whatever order they came in");
  assert.equal(a.pack.records.length + a.pack.inputs.log!.rejected.length, a.pack.inputs.log!.rows);
  assert.deepEqual(a.pack.summary.verdicts, { consistent: 1, "degraded-context": 2, unknown: 0 });
  assert.equal(a.pack.limitations[0], ENVIRONMENT_NOT_SPACECRAFT);
  assert.equal(a.pack.signature, null);
});

test("evidence pack: any change is detected: a record, its hash, the chain, the order, a dropped record (GAU-60)", async () => {
  const { pack } = await packFromStoredInputs();
  const edited = clone(pack);
  edited.records[0].inference.confidence = 0.5;
  assert.match(verifyEvidencePack(edited).join("\n"), /record 1 \(tr_\w+\) was changed/);

  rehashRecord(edited.records[0]);
  assert.match(verifyEvidencePack(edited).join("\n"), /the chain breaks at record 1/);

  relink(edited);
  assert.deepEqual(verifyEvidencePack(edited), ["the pack hash does not match the pack"], "only a trusted pack hash catches a full rewrite");

  const verdictChanged = clone(pack);
  verdictChanged.records[0].verdict.value = "degraded-context";
  rehashRecord(verdictChanged.records[0]);
  relink(verdictChanged);
  rehashPack(verdictChanged);
  assert.deepEqual(verifyEvidencePack(verdictChanged), ["the summary does not match the records"]);

  const swapped = clone(pack);
  [swapped.records[0], swapped.records[1]] = [swapped.records[1], swapped.records[0]];
  assert.match(verifyEvidencePack(swapped).join("\n"), /the chain breaks at record 1/);

  const dropped = clone(pack);
  dropped.records.pop();
  relink(dropped);
  rehashPack(dropped);
  assert.deepEqual(verifyEvidencePack(dropped), ["log rows not accounted for: 9 rows, 2 records, 6 rejected", "the summary does not match the records"]);
});

test("evidence pack: the wording rules hold even when the hashes are recomputed (GAU-60)", async () => {
  const { pack, records, inputs } = await packFromStoredInputs();
  const noLimitation = clone(pack);
  noLimitation.limitations = noLimitation.limitations.filter((l) => l !== ENVIRONMENT_NOT_SPACECRAFT);
  rehashPack(noLimitation);
  assert.deepEqual(verifyEvidencePack(noLimitation), ["the environment-not-spacecraft limitation is missing"]);

  const claims: Array<[string, RegExp]> = [
    ["Meets the EU AI Act", /regulatory claim "EU AI Act"/],
    ["The spacecraft experienced S2 protons", /puts the measurement at the spacecraft: "spacecraft experienced"/],
    ["Processor was exposed to high dose", /banned word "dose"/],
  ];
  for (const [text, expected] of claims) {
    const r = JSON.parse(JSON.stringify(records[0])) as TrustRecord;
    r.verdict.reasons.push(text);
    rehashRecord(r);
    assert.throws(() => buildEvidencePack([r, ...records.slice(1)], { window: WINDOW, generatedAtMs: NOW, inputs }), expected);
  }
  // The customer's own output is theirs: it is carried, never scanned.
  const theirs = buildTrustRecord({ ...ingestLog(csv, mapping).accepted[0].request, output: { label: "certified dose-free" } }, await replayed(), { nowMs: NOW });
  assert.deepEqual(verifyEvidencePack(buildEvidencePack([theirs, ...records.slice(1)], { window: WINDOW, generatedAtMs: NOW, inputs })), []);
});

test("evidence pack: refuses records outside the window, from another log or policy, or rows not accounted for (GAU-60)", async () => {
  const { records, inputs } = await packFromStoredInputs();
  const build = (rs: TrustRecord[], over: Partial<EvidenceInputs> = {}, window = WINDOW) => () => buildEvidencePack(rs, { window, generatedAtMs: NOW, inputs: { ...inputs, ...over } });
  assert.throws(build(records, {}, { from: WINDOW.from, to: "2026-01-19T03:00:00Z" }), /2 record\(s\) outside the window, e\.g\. 2026-01-19T04:50:30\.000Z/);
  assert.throws(build(records.slice(1)), /log rows not accounted for: 9 rows, 2 records, 6 rejected/);
  assert.throws(build(records, { log: { ...inputs.log!, fileSha256: "0".repeat(64) } }), /did not come from the log in this pack/);
  assert.throws(build(records, { policy: { ...DEFAULT_POLICY, degradedAtRadiation: 1 } }), /was judged under another policy/);
  assert.throws(build(records, { environment: { source: "live feed", archiveSha256: null } }), /was judged against "replay jan-2026", not "live feed"/);
  assert.throws(build([records[0], records[0], ...records.slice(1)], { log: { ...inputs.log!, rows: 10 } }), /appears twice/);
});

test("evidence pack: packs chain, each starting from the previous pack's hash (GAU-60)", async () => {
  const first = (await packFromStoredInputs()).pack;
  const next = (await packFromStoredInputs(first.packHash)).pack;
  assert.equal(next.chain.links[0].link, sha(first.packHash + next.records[0].hash));
  assert.notEqual(next.chain.head, first.chain.head);
  assert.deepEqual(verifyEvidencePack(next), []);
  const forked = clone(next);
  forked.inputs.previousPackHash = GENESIS;
  rehashPack(forked);
  assert.match(verifyEvidencePack(forked).join("\n"), /the chain breaks at record 1/);
});

test("evidence pack PDF: a valid PDF (cross-reference offsets, pages) carrying the pack hash and limitations (GAU-60)", async () => {
  const { pack } = await packFromStoredInputs();
  const pdf = renderEvidencePdf(pack);
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4\n") && text.endsWith("%%EOF\n"));
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  assert.equal(text.slice(startxref, startxref + 5), "xref\n");
  const entries = text.slice(startxref).split("\n").filter((l) => /^\d{10} 00000 n $/.test(l));
  entries.forEach((e, i) => assert.equal(text.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  const pages = (text.match(/\/Type \/Page /g) ?? []).length;
  assert.ok(pages >= 1);
  assert.match(text, new RegExp(`/Count ${pages} `));
  assert.ok(text.includes(`(${pack.packHash}) Tj`), "the full pack hash is printed");
  assert.ok(text.includes("(Environment, not spacecraft: this pack describes"), "the limitation is printed");
  assert.ok(text.includes(`(Page ${pages} of ${pages}) Tj`));
});

test("PDF writer: core-14 widths, WinAnsi encoding with transliteration, and lines that never overflow (GAU-60)", () => {
  assert.equal(HELVETICA_WIDTHS.length, 95);
  assert.equal(HELVETICA_BOLD_WIDTHS.length, 95);
  assert.equal(textWidth("Gauss", "Helvetica", 10), (778 + 556 + 556 + 500 + 500) / 100, "G a u s s from the AFM");
  assert.equal(textWidth("0123", "Courier", 10), 24);
  assert.deepEqual(winAnsi("≤ – é ∑"), [60, 61, 32, 0x96, 32, 0xe9, 32, 63]);
  const long = "Radiation storm S2 at geostationary orbit when the inference ran; tr_0123456789abcdef0123456789abcdef0123456789abcdef";
  for (const width of [40, 90, 175]) {
    const lines = wrap(long, "Helvetica", 7, width);
    assert.ok(lines.every((l) => textWidth(l, "Helvetica", 7) <= width), `width ${width}`);
    assert.equal(lines.join("").replace(/\s/g, ""), long.replace(/\s/g, ""), "nothing lost");
  }
});
