/**
 * Jetson / GPU inference-log profile pack (GAU-245): the Jetson Orin and H100 JSONL mappings, the
 * model-artefact identity in the trust record, and the MISSING processor entries.
 * Both fixtures are synthetic (SYNTH-* spacecraft, engine hashes of made-up strings), not customer data.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EnvironmentHistory } from "./environment.js";
import { ingestLog, mappingProblems, type LogMapping } from "./ingest.js";
import { MISSING_PROFILES, PROFILES } from "./profiles.js";
import { bannedWording, buildTrustRecord, parseTrustRequest, type TrustRecordRequest } from "./record.js";
import { upsetRiskField } from "./upset.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(here(p), "utf8")) as LogMapping;
const jetsonLog = readFileSync(here("fixtures/jetson-orin-inferences.jsonl"));
const h100Log = readFileSync(here("fixtures/gpu-h100-inferences.jsonl"));
const jetson = load("mappings/jetson-orin-jsonl.json");
const h100 = load("mappings/gpu-h100-jsonl.json");

const ENGINE_A = "746736ae30e0da3745bddedeaf9dfe225cc2191dcf248d3f2133e1b40ae0fca4";
const ENGINE_B = "10409ef1320c83eee699e2af3529cdd52a004aa70ec2e8740609ebf95bde84ac";
const ONNX_C = "61bd33dfa5ad74a2cdc657a80dc001c77c326130e89cf217d0715a7313b05a39";
const empty = new EnvironmentHistory([], "empty");
const NOW = { nowMs: Date.parse("2026-01-19T03:00:00.000Z") };

test("gpu logs: the shipped mappings are usable (GAU-245)", () => {
  assert.deepEqual(mappingProblems(jetson), []);
  assert.deepEqual(mappingProblems(h100), []);
});

test("gpu logs: Jetson rows carry the engine hash, TensorRT version and the mapped profile (GAU-245)", () => {
  const report = ingestLog(jetsonLog, jetson);
  assert.deepEqual(report.accepted.map((a) => a.request.ingest.row), [1, 2, 3, 8]);
  const [first, nx, otherEngine, upper] = report.accepted.map((a) => a.request);
  assert.equal(first.processorProfileId, "nvidia-jetson-agx-orin");
  assert.equal(nx.processorProfileId, "nvidia-jetson-orin-nx");
  assert.deepEqual(first.modelArtifact, { format: "tensorrt", sha256: ENGINE_A, runtime: "TensorRT", runtimeVersion: "10.3.0" });
  assert.deepEqual(first.output, { detections: [{ label: "vessel", score: 0.91 }] });
  assert.equal(otherEngine.modelArtifact?.sha256, ENGINE_B, "a second engine build at the same time is its own inference");
  assert.equal(upper.modelArtifact?.sha256, ENGINE_A, "hex is stored lowercase");
});

test("gpu logs: Jetson rows with a duplicate, an unmapped device or a bad artefact are rejected with reasons (GAU-245)", () => {
  const { accepted, rejected, file } = ingestLog(jetsonLog, jetson);
  assert.equal(accepted.length + rejected.length, file.rows, "every row accounted for");
  assert.deepEqual(rejected, [
    { row: 4, errors: ["duplicate of row 1 (same spacecraft, model, engine and time)"] },
    { row: 5, errors: ['device "Jetson Thor" is not in the mapping\'s processorProfiles table'] },
    { row: 6, errors: ["modelArtifact: sha256 must be 64 hex characters"] },
    { row: 7, errors: ["modelArtifact: format must be one of onnx, tensorrt, other"] },
  ]);
});

test("gpu logs: H100 rows take spacecraft, profile and runtime from constants (GAU-245)", () => {
  const report = ingestLog(h100Log, h100);
  assert.deepEqual(report.rejected, []);
  const r = report.accepted[0].request;
  assert.equal(r.time, "2026-01-19T02:10:00.000Z");
  assert.equal(r.spacecraftId, "SYNTH-H100-1");
  assert.equal(r.processorProfileId, "nvidia-h100");
  assert.deepEqual(r.modelArtifact, { format: "onnx", sha256: ONNX_C, runtime: "onnxruntime-gpu", runtimeVersion: "1.22.0" });
  assert.equal(r.output, "coastline, low cloud");
});

test("gpu logs: same bytes and mapping give the same records; a changed engine hash changes the record hash (GAU-245)", () => {
  const records = (bytes: Buffer) => ingestLog(bytes, jetson).accepted.map((a) => buildTrustRecord(a.request, empty, NOW));
  const once = records(jetsonLog);
  assert.deepEqual(records(jetsonLog), once);

  const [first] = once;
  assert.deepEqual(first.inference.modelArtifact, { format: "tensorrt", sha256: ENGINE_A, runtime: "TensorRT", runtimeVersion: "10.3.0" });
  const req = ingestLog(jetsonLog, jetson).accepted[0].request;
  const swapped = buildTrustRecord({ ...req, modelArtifact: { ...req.modelArtifact!, sha256: ENGINE_B } }, empty, NOW);
  assert.notEqual(swapped.hash, first.hash);
  assert.notEqual(swapped.recordId, first.recordId);
});

test("gpu logs: a record without an artefact has no modelArtifact key, so its hash is unchanged by this field (GAU-245)", () => {
  const base: TrustRecordRequest = { time: "2026-01-19T02:10:00.000Z", spacecraftId: "SYNTH-1", modelId: "m" };
  const parsed = parseTrustRequest(base);
  assert.ok("request" in parsed);
  const record = buildTrustRecord(parsed.request, empty, NOW);
  assert.ok(!("modelArtifact" in record.inference));
  assert.equal(record.hash, buildTrustRecord(base, empty, NOW).hash);
});

test("gpu logs: the API validates the artefact and never guesses one (GAU-245)", () => {
  const body = { time: "2026-01-19T02:10:00Z", spacecraftId: "s", modelId: "m" };
  const errs = (modelArtifact: unknown) => {
    const r = parseTrustRequest({ ...body, modelArtifact });
    return "errors" in r ? r.errors : [];
  };
  assert.deepEqual(errs({ format: "pytorch", sha256: ENGINE_A }), ["modelArtifact: format must be one of onnx, tensorrt, other"]);
  assert.deepEqual(errs({ format: "onnx", sha256: "zz" }), ["modelArtifact: sha256 must be 64 hex characters"]);
  assert.deepEqual(errs({ format: "onnx", sha256: ENGINE_A, verified: true }), ['modelArtifact: unknown field "verified"']);
  assert.deepEqual(errs({ format: "onnx", sha256: ENGINE_A, runtime: "" }), ["modelArtifact: runtime must be 1–128 characters"]);
  assert.deepEqual(errs("onnx"), ["modelArtifact: must be an object with format and sha256"]);
  const ok = parseTrustRequest({ ...body, modelArtifact: { format: "onnx", sha256: ENGINE_A.toUpperCase() } });
  assert.ok("request" in ok);
  assert.deepEqual(ok.request.modelArtifact, { format: "onnx", sha256: ENGINE_A, runtime: null, runtimeVersion: null });
  assert.equal((parseTrustRequest(body) as { request: TrustRecordRequest }).request.modelArtifact, null);
});

test("gpu logs: a mapping naming part of an artefact, or a device table without a column, is refused (GAU-245)", () => {
  const { modelFormat: _f, ...noFormat } = jetson.columns;
  assert.deepEqual(mappingProblems({ ...jetson, columns: noFormat }), ["a model artefact needs modelFormat and modelSha256 (a column or a constant)"]);
  const { processorProfileId: _p, ...noDevice } = jetson.columns;
  assert.deepEqual(mappingProblems({ ...jetson, columns: noDevice }), ["processorProfiles needs a processorProfileId column"]);
  assert.deepEqual(mappingProblems({ ...jetson, processorProfiles: { "Jetson AGX Orin": "" } }), ["processorProfiles must map device names to profile ids"]);
});

test("gpu logs: AGX Orin and H100 have no cited data, so the band is MISSING, never estimated (GAU-245)", () => {
  const ids = new Set(PROFILES.map((p) => p.id));
  for (const m of MISSING_PROFILES) {
    assert.ok(!ids.has(m.id), `${m.id} is not also a cited profile`);
    assert.match(m.missing, /^MISSING: /);
    assert.match(m.missing, /\d{4}-\d{2}-\d{2}/, `${m.id} says when it was searched`);
  }
  const quiet = { level: 0, why: "", observedAt: "2026-01-19T02:10:00.000Z", ageSeconds: 0 };
  for (const id of ["nvidia-jetson-agx-orin", "nvidia-h100"]) {
    const r = upsetRiskField(id, { saaTier: "core", saaWhy: "", s: quiet, g: quiet, lShell: 1.2 }, null);
    assert.equal(r.value, null);
    assert.equal(r.confidence, "none");
    assert.match(r.limitations[0], /MISSING: .*No upset-rate band is given; none is estimated from other devices\./);
  }
  // Every accepted fixture row builds a record with no banned wording (buildTrustRecord throws otherwise).
  for (const [log, m] of [[jetsonLog, jetson], [h100Log, h100]] as const) {
    for (const a of ingestLog(log, m).accepted) {
      const { hash: _h, ...rec } = buildTrustRecord(a.request, empty, NOW);
      assert.deepEqual(bannedWording(rec), []);
    }
  }
});
