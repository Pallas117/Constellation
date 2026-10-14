import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { diskFreeBytes, evaluate, ForecastSkillTracker, overall, readTpms, TPM_SPECS } from "./tpm.js";

const spec = (id: string) => TPM_SPECS.find((s) => s.id === id)!;

test("TPM: thresholds and margins for lower-is-better and higher-is-better measures (GAU-122)", () => {
  assert.equal(evaluate(spec("data_age"), 120).status, "green");
  assert.equal(evaluate(spec("data_age"), 700).status, "amber");
  const red = evaluate(spec("data_age"), 1000);
  assert.equal(red.status, "red");
  assert.equal(red.marginToRed, -100);
  const disk = evaluate(spec("disk_free"), 5);
  assert.equal(disk.status, "amber", "5 GB free is under the 10 GB amber limit");
  assert.equal(disk.marginToRed, 2);
  assert.equal(evaluate(spec("disk_free"), 2.5).status, "red");
  assert.equal(evaluate(spec("data_age"), null).status, "insufficient");
});

test("TPM: overall status never lets 'insufficient' hide amber or red (GAU-122)", () => {
  const r = (s: number | null, id = "data_age") => evaluate(spec(id), s);
  assert.equal(overall([r(1), r(null)]), "insufficient");
  assert.equal(overall([r(null), r(700)]), "amber");
  assert.equal(overall([r(1), r(700), r(2000)]), "red");
  assert.equal(overall([r(1)]), "green");
});

test("FMEA FM-09: live forecast skill is scored against observed Kp and compared with persistence (GAU-122)", () => {
  const t = new ForecastSkillTracker(3);
  const h = 3_600_000;
  // Model predicts the rise; persistence (Kp at issue) does not.
  t.record(0, 3, 5, 2);
  t.record(h, 3, 5, 2);
  assert.equal(t.resolve(2 * h, 5), 0, "nothing due before the 3 h target");
  t.record(2 * h, 3, 4, 3);
  assert.equal(t.skill().value, null, "insufficient until enough forecasts resolve");
  assert.equal(t.resolve(6 * h, 5), 3);
  const s = t.skill();
  assert.equal(s.samples, 3);
  assert.ok(s.maeModel! < s.maePersistence!);
  assert.ok(s.value! > 0, "beats persistence");
  // A model that is worse than persistence goes red.
  const bad = new ForecastSkillTracker(2);
  bad.record(0, 3, 8, 2);
  bad.record(0, 3, 8, 2);
  bad.resolve(3 * h, 2);
  assert.equal(evaluate(spec("forecast_skill"), bad.skill().value).status, "red");
});

test("FMEA FM-14: free disk is read from the data volume and graded (GAU-122)", async () => {
  const free = await diskFreeBytes(os.tmpdir());
  assert.ok(free !== null && free > 0);
  assert.equal(await diskFreeBytes("/definitely/not/a/dir"), null);
  const readings = readTpms({
    pipeline: { dataAgeMs: 60_000, lastTickAgeMs: 1_000, stages: [{ stage: "tick", p95Ms: 800, samples: 30 }] },
    failedWrites: 0,
    diskFreeBytes: 2e9,
    rssBytes: 300e6,
    sources: [{ source: "noaa-swpc", healthy: true }, { source: "goes-swpc", healthy: true }, { source: "esa-hapi", healthy: false }],
    skill: { value: null, samples: 4, maeModel: null, maePersistence: null },
  });
  const byId = Object.fromEntries(readings.map((r) => [r.id, r]));
  assert.equal(byId.disk_free.status, "red", "2 GB free is below the 3 GB red limit");
  assert.equal(byId.official_sources_down.value, 0, "only official sources count");
  assert.equal(byId.forecast_skill.status, "insufficient");
  assert.equal(overall(readings), "red");
});

test("TPM: a cold first tick after restart is not a red p95 (GAU-122)", () => {
  const base = {
    pipeline: { dataAgeMs: 60_000, lastTickAgeMs: 1_000, stages: [{ stage: "tick", p95Ms: 7_000, samples: 2 }] },
    failedWrites: 0, diskFreeBytes: 50e9, rssBytes: 300e6, sources: [],
    skill: { value: null, samples: 0, maeModel: null, maePersistence: null },
  };
  const cold = readTpms(base).find((r) => r.id === "tick_p95")!;
  assert.equal(cold.status, "insufficient");
  const steady = readTpms({ ...base, pipeline: { ...base.pipeline, stages: [{ stage: "tick", p95Ms: 7_000, samples: 40 }] } })
    .find((r) => r.id === "tick_p95")!;
  assert.equal(steady.status, "red", "a sustained slow p95 is still red");
});
