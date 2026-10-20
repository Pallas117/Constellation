import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { magnitude, vec } from "../physics/coordinates.js";
import { getCanonicalFeed } from "../state.js";
import { archiveBody, type ReplayArchive } from "./archive.js";
import { REPLAY_EVENTS } from "./events.js";
import { loadArchive, replayArchive, type ReplayRecord, type ReplaySummary } from "./replay.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// One replay per storm, shared by the tests below (they run one after another in this file).
const runs = new Map<string, Promise<{ records: ReplayRecord[]; summary: ReplaySummary }>>();
const run = (id: string) => {
  if (!runs.has(id)) runs.set(id, replayArchive(loadArchive(here(`events/${id}.json.gz`))));
  return runs.get(id)!;
};

test("replay: the cached storms replay to their golden output, record for record (GAU-138)", async () => {
  for (const { id } of REPLAY_EVENTS) {
    const { summary } = await run(id);
    const golden = JSON.parse(readFileSync(here(`golden/${id}.json`), "utf8")) as ReplaySummary;
    assert.deepEqual(summary, golden, `${id}: output changed; if intended, rerun npm run replay -- ${id} --update-golden`);
  }
});

test("replay: May 2024 reaches G5 and Oct 2024 G4 through the live pipeline (GAU-138)", async () => {
  const may = (await run("may-2024")).summary;
  assert.equal(may.peak.G, 5);
  assert.equal(may.firstReached.G["5"], "2024-05-11T00:00:00.000Z", "when the 21–24 UT Kp 9 interval completed");
  assert.equal(may.peak.R, 3, "the X5.8 flare");
  const oct = (await run("oct-2024")).summary;
  assert.equal(oct.peak.G, 4);
  assert.equal(oct.firstReached.G["4"], "2024-10-10T21:00:00.000Z");
});

test("replay: Jan 2026 reaches S4, with S2–S3 under G0 for hours before the geomagnetic storm (GAU-138)", async () => {
  const { records, summary } = await run("jan-2026");
  assert.equal(summary.peak.S, 4);
  assert.equal(summary.firstReached.S["4"], "2026-01-19T18:15:00.000Z");
  assert.equal(summary.firstReached.S["2"], "2026-01-19T04:45:00.000Z");
  assert.equal(summary.peak.G, 4, "Kp 8.33 then 9−: the geomagnetic storm was severe too, just later");
  const beforeG = records.filter((r) => r.t >= summary.firstReached.S["2"] && r.t < "2026-01-19T18:00:00.000Z");
  assert.ok(beforeG.length >= 13 * 60, "about 13 h of radiation storm before Kp reached 5");
  assert.ok(beforeG.every((r) => ["S2", "S3"].includes(r.S) && r.G === "G0"), "S2–S3 while the geomagnetic level was G0, never unknown");
});

test("replay: never publishes to the live feed (GAU-138)", async () => {
  const before = getCanonicalFeed().length;
  await run("oct-2024");
  assert.equal(getCanonicalFeed().length, before);
});

const tiny = (rows: Partial<ReplayArchive>): ReplayArchive => ({
  id: "t",
  title: "t",
  start: "2026-01-19T00:00:00Z",
  end: "2026-01-19T01:00:00Z",
  fetchedAt: "",
  sources: [],
  terms: "",
  mag: [],
  plasma: [],
  protons: [],
  electrons: [],
  xrays: [],
  kp: [],
  ...rows,
});

test("archive: a row is served only once its interval has ended, so nothing leaks from the future (GAU-138)", () => {
  const archive = tiny({
    protons: [["2026-01-19T00:00:00.000Z", 120, 3, 1, "GOES-18"]],
    kp: [["2026-01-18T21:00:00.000Z", "2026-01-19T00:00:00.000Z", 4.33]],
  });
  const at = (iso: string) => Date.parse(iso);
  const protonsAt = (iso: string) => archiveBody(archive, "/json/goes/primary/integral-protons-6-hour.json", at(iso)) as unknown[];
  assert.equal(protonsAt("2026-01-19T00:04:59Z").length, 0, "the 5-min average isn't out yet");
  assert.deepEqual(protonsAt("2026-01-19T00:05:00Z")[0], { time_tag: "2026-01-19T00:00:00.000Z", satellite: 18, flux: 120, energy: ">=10 MeV" });
  const kpAt = (iso: string) => archiveBody(archive, "/products/noaa-planetary-k-index.json", at(iso)) as unknown[];
  assert.equal(kpAt("2026-01-18T23:59:00Z").length, 0, "Kp counts only once its 3-hour interval has ended");
  assert.deepEqual(kpAt("2026-01-19T00:00:00Z"), [{ time_tag: "2026-01-18T21:00:00", Kp: 4.33 }]);
  assert.deepEqual(archiveBody(archive, "/json/planetary_k_index_1m.json", at("2026-01-19T00:30:00Z")), [], "not archived");
  assert.equal(archiveBody(archive, "/products/noaa-scales.json", at("2026-01-19T00:30:00Z")), undefined, "a 404, so unknown");
});

test("archive: archived GSM is rotated to GSE with the live code; RTSW fills reach the parser as null (GAU-138)", () => {
  const archive = tiny({
    mag: [
      ["2026-01-19T00:00:00.000Z", 3, -4, 12, 13.2, "ACE"],
      ["2026-01-19T00:01:00.000Z", -999.9, -999.9, -999.9, -999.9, "ACE"],
    ],
  });
  const rows = archiveBody(archive, "/json/rtsw/rtsw_mag_1m.json", Date.parse("2026-01-19T00:02:00Z")) as Array<Record<string, number | null | string>>;
  const [fillRow, row] = rows; // newest first, as SWPC serves it
  assert.equal(fillRow.bx_gsm, null);
  assert.equal(fillRow.bt, null);
  assert.equal(row.time_tag, "2026-01-19T00:00:00");
  const gse = vec(row.bx_gse as number, row.by_gse as number, row.bz_gse as number);
  assert.ok(Math.abs(magnitude(gse) - 13) < 1e-9, "a rotation keeps |B|");
  assert.equal(row.bx_gse, 3, "GSE and GSM share the x axis");
});

test("replay: the stuck ACE speed in Jan 2026 is flagged and lowers confidence; May and Oct 2024 never flag it (GAU-153)", async () => {
  const flagged = (records: ReplayRecord[]) => records.filter((r) => r.flags.includes("l1-plasma-tracking"));
  for (const id of ["may-2024", "oct-2024"]) assert.equal(flagged((await run(id)).records).length, 0, id);
  const jan = flagged((await run("jan-2026")).records);
  assert.ok(jan.length > 0, "not flagged");
  assert.ok(jan.every((r) => r.lowConfidence), "a flagged point kept full confidence");
  // From the field jump (~19:00 UT) until the speed reading recovers (~21:20 UT).
  const [first, last] = [jan[0].observedAt ?? "", jan[jan.length - 1].observedAt ?? ""];
  assert.ok(first >= "2026-01-19T18:50" && first <= "2026-01-19T19:20", `first ${first}`);
  assert.ok(last >= "2026-01-19T21:00" && last <= "2026-01-19T21:30", `last ${last}`);
});
