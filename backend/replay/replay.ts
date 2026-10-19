/**
 * Replay a historical storm through the live ingest → sense-check → nowcast code (GAU-138).
 *
 * The live IngestionWorker runs on a stepped clock at the live tick (5 s), with the live adapters
 * answered from the archive (see archive.ts). Nothing is published or persisted, so a replay
 * never touches the live feed. Output: one record per minute, plus a summary whose hashes make
 * the run checkable against a golden file. Same inputs, same records.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import { IngestionWorker, TICK_MS } from "../worker/ingest-loop.js";
import { archiveFetch, type ReplayArchive } from "./archive.js";

export interface ReplayRecord {
  /** Replay clock (UTC). */
  t: string;
  observedAt: string | null;
  spacecraft: string | null;
  tier: number;
  stale: boolean;
  lowConfidence: boolean;
  /** Latest L1 values on the point (GSM, nT; km/s; cm^-3). */
  bz: number;
  speed: number;
  density: number;
  /** Solar wind reaching Earth now, or null. */
  arrivingBz: number | null;
  kp: number;
  kpKind: string | null;
  dst: number;
  dstMethod: string;
  stormTier: string;
  S: string;
  G: string;
  R: string;
  protons: number | null;
  xray: string | null;
  /** Sense-checks that flagged, and those with nothing current to check. */
  flags: string[];
  unknown: string[];
}

export interface ReplaySummary {
  id: string;
  start: string;
  end: string;
  minutes: number;
  inputsSha256: string;
  recordsSha256: string;
  peak: { S: number | null; G: number | null; R: number | null; kp: number; protons: number | null; dstMin: number; bzMin: number };
  /** First minute each level was reached, per scale ("1" … "5"). */
  firstReached: Record<"S" | "G" | "R", Record<string, string>>;
  /** Minutes each sense-check flagged, or had nothing to check. */
  checks: Record<string, { flag: number; unknown: number }>;
  staleMinutes: number;
}

/** Round so records hash the same across Node versions and platforms (last-bit Math differences). */
const r = (v: number, digits = 3) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : v);
const sig = (v: number) => Number(v.toPrecision(4));

export function toRecord(t: number, p: CanonicalSpaceWeatherPoint): ReplayRecord {
  const checks = p.senseChecks ?? [];
  return {
    t: new Date(t).toISOString(),
    observedAt: p.observedAt ?? null,
    spacecraft: p.spacecraft ?? null,
    tier: p.quality.tier ?? 0,
    stale: p.quality.stale === true,
    lowConfidence: p.quality.lowConfidence === true,
    bz: r(p.magneticField.z),
    speed: r(p.solarWind.speed, 1),
    density: r(p.solarWind.density),
    arrivingBz: p.arriving ? r(p.arriving.bz) : null,
    kp: r(p.indices.kp, 2),
    kpKind: p.indices.kpKind ?? null,
    dst: r(p.indices.dst, 1),
    dstMethod: p.indices.dstMethod,
    stormTier: p.alerts.stormTier,
    S: p.alerts.radiation?.label ?? "S?",
    G: p.alerts.geomagnetic?.label ?? "G?",
    R: p.alerts.radioBlackout?.label ?? "R?",
    protons: p.particles?.protons ? sig(p.particles.protons.value) : null,
    xray: p.xray?.flareClass ?? null,
    flags: checks.filter((c) => c.status === "flag").map((c) => c.id),
    unknown: checks.filter((c) => c.status === "unknown").map((c) => c.id),
  };
}

export function loadArchive(path: string): ReplayArchive {
  const raw = readFileSync(path);
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")) as ReplayArchive;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Run the archive's window through the live worker. Swaps the global fetch for the archive
 * while it runs, so it must not run inside the live server process.
 */
export async function replayArchive(
  archive: ReplayArchive,
  options: { stepMs?: number; recordEveryMs?: number } = {},
): Promise<{ records: ReplayRecord[]; summary: ReplaySummary }> {
  const stepMs = options.stepMs ?? TICK_MS;
  const recordEveryMs = options.recordEveryMs ?? 60_000;
  const start = Date.parse(archive.start);
  const end = Date.parse(archive.end);
  let clock = start;
  const worker = new IngestionWorker(undefined, {
    now: () => clock,
    sources: ["noaa", "goes"],
    forecast: false,
    auroraGrid: false,
    publish: false,
    respectLink: false,
  });

  const records: ReplayRecord[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = archiveFetch(archive, () => clock);
  try {
    for (; clock < end; clock += stepMs) {
      const { canonicalPoint } = await worker.tick();
      if (canonicalPoint && (clock - start) % recordEveryMs === 0) records.push(toRecord(clock, canonicalPoint));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return { records, summary: summarise(archive, records) };
}

const level = (label: string) => (/^[SGR]\d$/.test(label) ? Number(label[1]) : null);

export function summarise(archive: ReplayArchive, records: ReplayRecord[]): ReplaySummary {
  const firstReached: ReplaySummary["firstReached"] = { S: {}, G: {}, R: {} };
  const peak: ReplaySummary["peak"] = { S: null, G: null, R: null, kp: 0, protons: null, dstMin: Infinity, bzMin: Infinity };
  const checks: ReplaySummary["checks"] = {};
  let staleMinutes = 0;
  for (const rec of records) {
    for (const scale of ["S", "G", "R"] as const) {
      const lv = level(rec[scale]);
      if (lv === null) continue;
      peak[scale] = Math.max(peak[scale] ?? 0, lv);
      for (let k = 1; k <= lv; k += 1) firstReached[scale][String(k)] ??= rec.t;
    }
    peak.kp = Math.max(peak.kp, rec.kp);
    if (rec.protons !== null) peak.protons = Math.max(peak.protons ?? 0, rec.protons);
    peak.dstMin = Math.min(peak.dstMin, rec.dst);
    if (!rec.stale) peak.bzMin = Math.min(peak.bzMin, rec.bz);
    for (const id of rec.flags) (checks[id] ??= { flag: 0, unknown: 0 }).flag += 1;
    for (const id of rec.unknown) (checks[id] ??= { flag: 0, unknown: 0 }).unknown += 1;
    if (rec.stale) staleMinutes += 1;
  }
  return {
    id: archive.id,
    start: archive.start,
    end: archive.end,
    minutes: records.length,
    inputsSha256: sha256(JSON.stringify(archive)),
    recordsSha256: sha256(records.map((x) => JSON.stringify(x)).join("\n")),
    peak,
    firstReached,
    checks: Object.fromEntries(Object.entries(checks).sort(([a], [b]) => a.localeCompare(b))),
    staleMinutes,
  };
}
