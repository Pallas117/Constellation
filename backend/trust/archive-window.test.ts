import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { loadArchive, replayArchive } from "../replay/replay.js";
import type { ReplayArchive } from "../replay/archive.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import { archivePathFor, outsideWindow } from "./archive-window.js";
import { EnvironmentHistory } from "./environment.js";
import { ingestLog, type LogMapping } from "./ingest.js";
import { buildTrustRecord } from "./record.js";

const mapping: LogMapping = {
  schema: "gauss.log-mapping/0.1",
  id: "generic-csv",
  version: "0.1.0",
  format: "csv",
  timeFormat: "iso",
  columns: { time: "inference_time", spacecraftId: "sat", modelId: "model", output: ["label"], confidence: "score" },
};

/** A tiny synthetic custom-window archive (the fetch-archive tests cover how one is made); not customer data. */
function customArchive(): ReplayArchive {
  const minute = (i: number) => new Date(Date.parse("2026-03-02T00:00:00Z") + i * 60_000).toISOString();
  const rows = Array.from({ length: 120 }, (_, i) => minute(i));
  return {
    id: "custom-demo",
    title: "Customer window",
    start: "2026-03-02T00:00:00.000Z",
    end: "2026-03-02T01:30:00.000Z",
    fetchedAt: "2026-03-10T00:00:00.000Z",
    sources: [{ dataset: "swpc_rtsw_mag_P1M", url: "https://iswa.gsfc.nasa.gov/IswaSystemWebApp/hapi/data" }],
    terms: "test",
    mag: rows.map((t) => [t, 1, -2, -4, 5, "DSCOVR"]),
    plasma: rows.map((t) => [t, 5, 420, "DSCOVR", 90000]),
    protons: [],
    electrons: [],
    xrays: [],
    kp: [],
  };
}

test("custom archive ingest: --replay takes only a slug, --archive a path outside the repo, never both (GAU-59)", () => {
  assert.equal(archivePathFor("/repo", "pilot-2026-01", undefined), "/repo/backend/replay/events/pilot-2026-01.json.gz");
  assert.equal(archivePathFor("/repo", undefined, "/somewhere/else/customer.json.gz"), "/somewhere/else/customer.json.gz");
  assert.throws(() => archivePathFor("/repo", "../../etc/passwd", undefined), /invalid --replay id/);
  assert.throws(() => archivePathFor("/repo", "a/b", undefined), /invalid --replay id/);
  assert.throws(() => archivePathFor("/repo", "x", "/y.json.gz"), /exactly one/);
  assert.throws(() => archivePathFor("/repo", undefined, undefined), /exactly one/);
});

test("custom archive ingest: rows outside the archive window are named per row; rows inside are judged against the custom archive (GAU-59)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gauss-custom-archive-"));
  try {
    const path = join(dir, "custom-demo.json.gz");
    writeFileSync(path, gzipSync(JSON.stringify(customArchive())));
    const archive = loadArchive(path);
    const log = Buffer.from(
      [
        "inference_time,sat,model,label,score",
        "2026-03-01T23:00:00Z,SAT-A,m1,clear,0.9",
        "2026-03-02T00:40:00Z,SAT-A,m1,clear,0.9",
        "2026-03-02T01:00:00Z,SAT-A,m1,cloud,0.8",
        "2026-03-02T05:00:00Z,SAT-A,m1,clear,0.9",
      ].join("\n") + "\n",
    );
    const report = ingestLog(log, mapping);
    assert.equal(report.accepted.length, 4);
    const outside = outsideWindow(
      report.accepted.map((a) => ({ row: a.request.ingest.row, time: a.request.time })),
      archive.start,
      archive.end,
      "archive window",
    );
    assert.deepEqual(outside.map((o) => o.row), [1, 4]);
    assert.match(outside[0].errors[0], /outside the archive window 2026-03-02T00:00:00.000Z to 2026-03-02T01:30:00.000Z \(row time 2026-03-01T23:00:00.000Z\)/);
    const points: CanonicalSpaceWeatherPoint[] = [];
    await replayArchive(archive, { points });
    const history = new EnvironmentHistory(points, `replay ${archive.id}`);
    const records = report.accepted
      .filter((a) => !outside.some((o) => o.row === a.request.ingest.row))
      .map((a) => buildTrustRecord(a.request, history, { nowMs: Date.parse(archive.end) }));
    assert.deepEqual(records.map((r) => r.inference.ingest?.row), [2, 3]);
    assert.equal(records[0].environmentSource, "replay custom-demo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
