import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VERDICT_LABEL, VERDICT_NEXT_STEP, VERDICT_ORDER } from "../../shared/policy/verdict-next-step.js";
import { buildEvidencePack, ENVIRONMENT_NOT_SPACECRAFT, GENESIS, packWording, verifyEvidencePack, type EvidenceInputs } from "./evidence.js";
import { CURRENT_EVIDENCE_PDF_RENDERER, declaredEvidencePdfRenderer, renderEvidencePdf } from "./evidence-pdf.js";
import { archivePath, clone, csv, mapping, NOW, packFromStoredInputs, rehashPack, rehashRecord, relink, replayed, sha, WINDOW } from "./fixtures/evidence-pack.js";
import { ingestLog } from "./ingest.js";
import { HELVETICA_BOLD_WIDTHS, HELVETICA_WIDTHS, textWidth, winAnsi, wrap } from "./pdf.js";
import { checkPack } from "./pack-check.js";
import { buildTrustRecord, DEFAULT_POLICY, wordingHits, type TrustRecord, type Verdict } from "./record.js";
import { KEYRING_SCHEMA, type Keyring } from "./signing.js";

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
  assert.deepEqual(verifyEvidencePack(edited), ["the pack hash does not match the pack"], "without a signature, only a trusted pack hash catches a full rewrite");

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

test("next step per verdict: one reviewed line for every verdict, in plain ASCII, with no claim a pack may not make (GAU-59)", async () => {
  const verdicts: Verdict[] = ["consistent", "degraded-context", "unknown"];
  assert.deepEqual([...VERDICT_ORDER].sort(), [...verdicts].sort(), "every verdict is ordered once");
  for (const v of verdicts) {
    assert.ok(VERDICT_NEXT_STEP[v].length > 40, `${v} has a next step`);
    assert.match(VERDICT_NEXT_STEP[v], /^[\x20-\x7e]+$/, `${v} is plain ASCII, so the PDF prints it as written`);
    assert.ok(VERDICT_LABEL[v]);
  }
  assert.deepEqual(wordingHits(Object.values(VERDICT_NEXT_STEP)), [], "no banned words");
  // The default policy gives "consistent" without orbit context (record.ts verdictFor), so the line
  // must not promise that nothing needs a second look; reword it if the default ever changes.
  assert.equal(DEFAULT_POLICY.requireOrbitContext, false);
  assert.doesNotMatch(VERDICT_NEXT_STEP.consistent, /nothing in the conditions/i, "consistent makes no blanket all-clear");
  assert.match(VERDICT_NEXT_STEP.consistent, /South Atlantic Anomaly counts only where it was assessed/, "consistent says the SAA may not have been assessed");
  assert.match(VERDICT_NEXT_STEP.unknown, /conflicting/, "unknown covers conflicting inputs, as verdictFor does");
  const { pack } = await packFromStoredInputs();
  assert.deepEqual(packWording({ ...pack, limitations: Object.values(VERDICT_NEXT_STEP) }), [], "no regulatory or at-the-spacecraft claims");
});

test("evidence pack PDF: the next step is printed for each verdict the pack holds, and only those (GAU-59)", async () => {
  const { pack } = await packFromStoredInputs();
  const firstWords = (v: Verdict) => VERDICT_NEXT_STEP[v].split(" ").slice(0, 4).join(" ");
  const check = (p: typeof pack) => {
    const text = renderEvidencePdf(p).toString("latin1");
    for (const v of VERDICT_ORDER) {
      const held = p.summary.verdicts[v] > 0;
      assert.equal(text.includes(`(If ${VERDICT_LABEL[v]}) Tj`), held, `${v}: key printed only when held`);
      assert.equal(text.includes(`(${firstWords(v)}`), held, `${v}: step printed only when held`);
    }
    return text;
  };
  check(pack);
  // Every verdict at once, and none: the section follows the counts.
  const all = clone(pack);
  all.summary.verdicts = { consistent: 1, "degraded-context": 1, unknown: 1 };
  assert.ok(check(all).includes("(What to do next) Tj"));
  const none = clone(pack);
  none.summary.verdicts = { consistent: 0, "degraded-context": 0, unknown: 0 };
  assert.ok(!check(none).includes("(What to do next) Tj"));
  assert.ok(!JSON.stringify(pack).includes(firstWords("consistent")), "the lines are not part of the hashed pack");
});

test("evidence pack PDF: renderer versions; a PDF made before the next steps (renderer 1) still verifies, a tampered or relabelled one fails (GAU-59)", async () => {
  const { pack } = await packFromStoredInputs();
  const ring: Keyring = { schema: KEYRING_SCHEMA, keys: [] };
  const verify = (bytes: Buffer) => checkPack(pack, ring, { subject: "pack.json", keyringLabel: "test keyring", allowUnsigned: true, pdf: { bytes, label: "pack.pdf" } });
  const latin1 = (b: Buffer) => b.toString("latin1");
  const edit = (b: Buffer, from: string, to: string) => {
    assert.ok(latin1(b).includes(from), `the PDF holds ${from}`);
    return Buffer.from(latin1(b).replace(from, to), "latin1");
  };

  // Renderer 1 is the rendering every PDF had before GAU-59: /Producer "Gauss", no next steps, no version line.
  const v1 = renderEvidencePdf(pack, 1);
  assert.ok(latin1(v1).includes("/Producer (Gauss) /CreationDate"));
  assert.ok(!latin1(v1).includes("(What to do next) Tj") && !latin1(v1).includes("(PDF renderer) Tj"));
  assert.equal(declaredEvidencePdfRenderer(v1), 1, "no version declared = renderer 1");
  const old = verify(v1);
  assert.equal(old.ok, true, old.lines.join("\n"));
  assert.match(old.lines.join("\n"), /pack\.pdf matches/);
  assert.match(old.lines.join("\n"), /NOTE: pack\.pdf was made by an older Gauss \(PDF renderer version 1\) and matches that rendering/);

  // The current renderer names itself and verifies without the older-Gauss note.
  const v2 = renderEvidencePdf(pack);
  assert.equal(CURRENT_EVIDENCE_PDF_RENDERER, 2);
  assert.ok(latin1(v2).includes("/Producer (Gauss evidence-pdf renderer 2) /CreationDate"));
  assert.ok(latin1(v2).includes("(What to do next) Tj") && latin1(v2).includes("(version 2) Tj"));
  assert.equal(declaredEvidencePdfRenderer(v2), 2);
  const current = verify(v2);
  assert.equal(current.ok, true, current.lines.join("\n"));
  assert.ok(!current.notes.some((n) => n.includes("older Gauss")));

  // Tampering fails under either renderer (same length, so the cross-reference table stays valid).
  for (const [renderer, good] of [[1, v1], [2, v2]] as const) {
    const bad = verify(edit(good, `(${pack.packHash}) Tj`, `(${"0".repeat(64)}) Tj`));
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.problems, [`pack.pdf is not the rendering of this pack (PDF renderer version ${renderer})`]);
  }
  // Relabelling does not help: a current PDF claiming renderer 1 is not the renderer-1 rendering, and vice versa.
  assert.equal(verify(edit(v2, "/Producer (Gauss evidence-pdf renderer 2)", "/Producer (Gauss)")).ok, false);
  assert.equal(verify(edit(v1, "/Producer (Gauss)", "/Producer (Gauss evidence-pdf renderer 2)")).ok, false);
  // A version this Gauss does not have is named as such, not called a forgery.
  const future = verify(edit(v2, "renderer 2)", "renderer 9)"));
  assert.equal(future.ok, false);
  assert.match(future.problems.join("\n"), /says it was made by PDF renderer version 9, which this Gauss version does not have \(it has 1, 2\); verify it with a newer Gauss/);
  // Text drawn on a page cannot declare a version: the writer escapes "(" in page text.
  const trick = clone(pack);
  trick.limitations = [...trick.limitations, "/Producer (Gauss evidence-pdf renderer 2)"];
  assert.equal(declaredEvidencePdfRenderer(renderEvidencePdf(trick, 1)), 1);
  assert.throws(() => renderEvidencePdf(pack, 3 as never), RangeError);
});
