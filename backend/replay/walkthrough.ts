/**
 * Data for the guided storm walkthrough on /heliophysics (GAU-229): a replayed storm, thinned to
 * one sample every few minutes, plus the South Atlantic Anomaly outline for that date.
 *
 * Every number comes from the live pipeline's replay of the cached archive (replay.ts, GAU-138)
 * and from IGRF-14 (saa.ts thresholds), so the scene shows measured data, never a scenario.
 * `npm run replay:walkthrough` writes the file the frontend imports; replay.test.ts checks the
 * committed file still matches the replay.
 */
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import { IGRF_LABEL, igrfAt } from "../physics/igrf.js";
import { SAA_CORE_NT, SAA_EXTENDED_NT } from "../trust/saa.js";
import { RE_KM } from "../trust/orbit.js";
import type { ReplayArchive } from "./archive.js";
import type { ReplayRecord, ReplaySummary } from "./replay.js";

/** Solar wind values, GSM: nT, nPa, km/s, cm^-3. */
export interface WalkthroughWind {
  bz: number;
  by: number;
  pdyn: number;
  speed: number;
  density: number;
}

export interface WalkthroughSample {
  t: string;
  /** Latest L1 measurement (what reaches Earth next). */
  l1: WalkthroughWind;
  /** L1 spacecraft of the latest measurement. */
  spacecraft: string | null;
  /** Solar wind reaching Earth now (propagated 5-min mean), or null when none was arriving. */
  arriving: (WalkthroughWind & { travelMin: number; spacecraft: string }) | null;
  kp: number | null;
  kpKind: string | null;
  dst: number;
  dstMethod: string;
  S: string;
  G: string;
  R: string;
  /** GOES >=10 MeV protons, pfu. */
  protons: number | null;
  xray: string | null;
}

export interface WalkthroughData {
  id: string;
  title: string;
  start: string;
  end: string;
  stepMin: number;
  source: string;
  /** Hashes of the replay this was cut from: the same as golden/<id>.json. */
  inputsSha256: string;
  recordsSha256: string;
  saa: {
    altKm: number;
    epoch: string;
    model: string;
    /** Outlines as [lat, lon] degrees, one vertex per bearing from the field minimum. */
    core: [number, number][];
    extended: [number, number][];
    minimum: { lat: number; lon: number; nT: number };
    thresholds: { coreNt: number; extendedNt: number; source: string };
  };
  samples: WalkthroughSample[];
}

export const WALKTHROUGH_STEP_MIN = 5;
export const WALKTHROUGH_SAA_ALT_KM = 400;

const r = (v: number, digits = 2) => Number(v.toFixed(digits));

const wind = (bz: number, by: number, pdyn: number, speed: number, density: number): WalkthroughWind => ({
  bz: r(bz),
  by: r(by),
  pdyn: r(pdyn),
  speed: r(speed, 1),
  density: r(density),
});

export function walkthroughSample(record: ReplayRecord, p: CanonicalSpaceWeatherPoint): WalkthroughSample {
  const a = p.arriving;
  return {
    t: record.t,
    l1: wind(p.magneticField.z, p.magneticField.y, p.solarWind.dynamicPressure, p.solarWind.speed, p.solarWind.density),
    spacecraft: record.spacecraft,
    arriving: a
      ? { ...wind(a.bz, a.by, a.dynamicPressure, a.speed, a.density), travelMin: r(a.travelSeconds / 60, 1), spacecraft: a.spacecraft }
      : null,
    kp: record.kp,
    kpKind: record.kpKind,
    dst: record.dst,
    dstMethod: record.dstMethod,
    S: record.S,
    G: record.G,
    R: record.R,
    protons: record.protons,
    xray: record.xray,
  };
}

/** Destination point from (lat, lon) along `bearing` for `distDeg` of great circle. */
function destination(lat: number, lon: number, bearing: number, distDeg: number): [number, number] {
  const d = (Math.PI / 180) * distDeg;
  const φ1 = (Math.PI / 180) * lat;
  const λ1 = (Math.PI / 180) * lon;
  const θ = (Math.PI / 180) * bearing;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  const lonDeg = (((λ2 * 180) / Math.PI + 540) % 360) - 180;
  return [r((φ2 * 180) / Math.PI), r(lonDeg)];
}

/**
 * The SAA at `altKm` on `ms`: the IGRF-14 total-field minimum over the South Atlantic, and the
 * outlines where |B| crosses the saa.ts tiers, found by walking out from the minimum on each bearing.
 */
export function saaOutline(ms: number, altKm = WALKTHROUGH_SAA_ALT_KM, bearings = 72): WalkthroughData["saa"] {
  const radius = RE_KM + altKm;
  const field = (lat: number, lon: number) => {
    const f = igrfAt(ms, lat, lon, radius);
    if (!f) throw new Error(`${IGRF_LABEL} does not cover ${new Date(ms).toISOString()}`);
    return f.total;
  };
  let min = { lat: 0, lon: 0, nT: Number.POSITIVE_INFINITY };
  for (let lat = -60; lat <= 10; lat += 1) {
    for (let lon = -110; lon <= 40; lon += 1) {
      const nT = field(lat, lon);
      if (nT < min.nT) min = { lat, lon, nT };
    }
  }
  const outline = (threshold: number) => {
    const out: [number, number][] = [];
    for (let i = 0; i < bearings; i++) {
      const bearing = (360 * i) / bearings;
      let lo = 0;
      let hi = 0;
      // Step out 0.5° at a time to the first point above the threshold, then bisect.
      while (hi < 80 && field(...destination(min.lat, min.lon, bearing, hi)) <= threshold) {
        lo = hi;
        hi += 0.5;
      }
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        if (field(...destination(min.lat, min.lon, bearing, mid)) <= threshold) lo = mid;
        else hi = mid;
      }
      out.push(destination(min.lat, min.lon, bearing, lo));
    }
    return out;
  };
  return {
    altKm,
    epoch: new Date(ms).toISOString(),
    model: IGRF_LABEL,
    core: outline(SAA_CORE_NT),
    extended: outline(SAA_EXTENDED_NT),
    minimum: { lat: min.lat, lon: min.lon, nT: Math.round(min.nT) },
    thresholds: {
      coreNt: SAA_CORE_NT,
      extendedNt: SAA_EXTENDED_NT,
      source: "AMS-01 field thresholds (Fiandrini et al. 2002, 2003), as in backend/trust/saa.ts",
    },
  };
}

export function walkthroughData(
  archive: ReplayArchive,
  run: { records: ReplayRecord[]; points: CanonicalSpaceWeatherPoint[]; summary: ReplaySummary },
  stepMin = WALKTHROUGH_STEP_MIN,
): WalkthroughData {
  if (run.records.length !== run.points.length) throw new Error("records and points differ in length");
  const start = Date.parse(archive.start);
  const samples: WalkthroughSample[] = [];
  run.records.forEach((record, i) => {
    if ((Date.parse(record.t) - start) % (stepMin * 60_000) === 0) samples.push(walkthroughSample(record, run.points[i]));
  });
  const mid = (start + Date.parse(archive.end)) / 2;
  return {
    id: archive.id,
    title: archive.title,
    start: archive.start,
    end: archive.end,
    stepMin,
    source:
      "NOAA SWPC real-time solar wind, GOES and Kp products (archived by NASA CCMC iSWA), replayed through the live Gauss pipeline (GAU-138)",
    inputsSha256: run.summary.inputsSha256,
    recordsSha256: run.summary.recordsSha256,
    saa: saaOutline(mid),
    samples,
  };
}
