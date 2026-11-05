/**
 * Cache a storm's inputs for the offline replay (GAU-138):
 *   npm run replay:fetch -- may-2024 [oct-2024 …]   (also the GAU-154 holdout ids)
 *
 * Reads the archived SWPC real-time products from NASA CCMC iSWA (HAPI) and writes
 * backend/replay/events/<id>.json.gz. Run once per event; the replay and its tests never touch
 * the network. Kyoto Dst is not fetched: its redistribution terms are unchecked and this
 * repository is public.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { ReplayArchive } from "../../backend/replay/archive.js";
import { eventById, WARMUP_HOURS, type ReplayEvent } from "../../backend/replay/events.js";
import { holdoutById } from "../../backend/replay/holdout.js";

const ISWA = "https://iswa.gsfc.nasa.gov/IswaSystemWebApp/hapi/data";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../backend/replay/events");

const TERMS =
  "NOAA SWPC real-time products (US Government work, public domain) as archived by NASA CCMC iSWA. " +
  "Acknowledge NOAA SWPC and the NASA Community Coordinated Modeling Center when publishing results.";

/** HAPI CSV rows (parameters must be listed in the dataset's own order). */
async function hapi(base: string, id: string, parameters: string[], from: string, to: string): Promise<string[][]> {
  const url = `${base}?id=${id}&time.min=${from}&time.max=${to}&parameters=${parameters.join(",")}&format=csv`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d{4}-/.test(line))
    .map((line) => line.split(","));
}

const iso = (t: string) => new Date(Date.parse(t)).toISOString();
const num = (v: string | undefined) => (v === undefined || v === "" ? Number.NaN : Number(v));
const sorted = <T extends [string, ...unknown[]]>(rows: T[]) => rows.sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));

async function fetchEvent(event: ReplayEvent): Promise<ReplayArchive> {
  const from = new Date(Date.parse(event.start) - WARMUP_HOURS * 3_600_000).toISOString();
  const to = event.end;
  const [mag, plasma, protons, electrons, xrays, kp] = await Promise.all([
    hapi(ISWA, "swpc_rtsw_mag_P1M", ["B_x", "B_y", "B_z", "B_t", "isPrimary", "source"], from, to),
    hapi(ISWA, "swpc_rtsw_plasma_P1M", ["ProtonDensity", "BulkSpeed", "IonTemperature", "isPrimary", "source"], from, to),
    hapi(ISWA, "goesp_part_flux_P5M", ["P10", "P50", "P100", "satelliteProton"], from, to),
    hapi(ISWA, "goesp_part_flux_P5M", ["E2_0", "satelliteElectron"], from, to),
    hapi(ISWA, "goesp_xray_flux_P1M", ["Short_Wave", "Long_Wave", "satellite"], from, to),
    // Kp intervals that end inside the window; the replay serves each only once it has ended.
    hapi(ISWA, "NOAA_KP_P3H", ["Kp_observed", "StartTime", "EndTime"], new Date(Date.parse(from) - 6 * 3_600_000).toISOString(), to),
  ]);
  return {
    id: event.id,
    title: event.title,
    start: event.start,
    end: event.end,
    fetchedAt: new Date().toISOString(),
    sources: [{ dataset: "swpc_rtsw_mag_P1M, swpc_rtsw_plasma_P1M, goesp_part_flux_P5M, goesp_xray_flux_P1M, NOAA_KP_P3H", url: ISWA }],
    terms: TERMS,
    // Only the operational spacecraft (isPrimary = 1), as the live pipeline uses it.
    mag: sorted(mag.filter((r) => r[5] === "1").map((r) => [iso(r[0]), num(r[1]), num(r[2]), num(r[3]), num(r[4]), r[6]])),
    // Temperature last, so the older rows' positions still hold (GAU-139 part B needs T/T_exp).
    plasma: sorted(plasma.filter((r) => r[4] === "1").map((r) => [iso(r[0]), num(r[1]), num(r[2]), r[5], num(r[3])])),
    protons: sorted(protons.map((r) => [iso(r[0]), num(r[1]), num(r[2]), num(r[3]), r[4]])),
    electrons: sorted(electrons.map((r) => [iso(r[0]), num(r[1]), r[2]])),
    xrays: sorted(xrays.map((r) => [iso(r[0]), num(r[2]), num(r[1]), r[3]])),
    kp: sorted(
      kp
        .filter((r) => Number.isFinite(num(r[1])) && num(r[1]) >= 0)
        .map((r) => [iso(r[2]), iso(r[3]), num(r[1])] as [string, string, number]),
    ),
  };
}

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: npm run replay:fetch -- <event id> [...]");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
for (const id of ids) {
  const event = eventById(id) ?? holdoutById(id); // holdout storms: GAU-154
  if (!event) throw new Error(`unknown event ${id}`);
  const archive = await fetchEvent(event);
  const path = join(OUT, `${id}.json.gz`);
  writeFileSync(path, gzipSync(JSON.stringify(archive), { level: 9 }));
  const counts = (["mag", "plasma", "protons", "electrons", "xrays", "kp"] as const).map((k) => `${k} ${archive[k].length}`);
  console.log(`${id}: ${counts.join(", ")} → ${path}`);
}
