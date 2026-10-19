/**
 * The NOAA SWPC RTSW 1-minute files as a validated L1 time series.
 *
 * Each file holds 24 h of minutes for every L1 spacecraft (SOLAR1, IMAP, ACE),
 * newest first, with the operational one marked `active`. This module pairs
 * the wind and mag records, rejects fill and implausible values, cross-checks
 * the active spacecraft's density against the others, and propagates the
 * series ballistically to Earth so the model can show the solar wind that is
 * arriving now rather than the one that will arrive in ~45 min.
 */
import { vec, type Vector3 } from "../physics/coordinates.js";
import type { ArrivingSolarWind, DensityDisagreement } from "../types.js";

type Rec = Record<string, unknown>;

export interface L1Sample {
  /** Measurement time, ms (the older of the paired wind and mag records). */
  t: number;
  spacecraft: string;
  /** Proton density, cm^-3. */
  density: number;
  /** Bulk speed, km/s. */
  speed: number;
  velocityGse: Vector3;
  /** Published GSM velocity when present; null to convert locally. */
  velocityGsm: Vector3 | null;
  magneticFieldGse: Vector3;
  /** Published GSM field when present; null to convert locally. */
  magneticFieldGsm: Vector3 | null;
  /** Published Bt (mean of the 1-s magnitudes), nT; null when absent. Sense-checked, GAU-136. */
  bt?: number | null;
}

/**
 * Plausibility bounds. ACE's degraded SWEPAM reports densities of 0.0-0.1 cm^-3;
 * the quietest solar wind on record is ~0.1-0.2 cm^-3, so anything below is a fill.
 */
export const PLAUSIBLE = {
  densityMin: 0.1,
  densityMax: 150,
  speedMin: 200,
  speedMax: 3000,
  fieldMaxNt: 300,
} as const;

/** Mag and wind records further apart than this are not paired. */
const PAIR_TOLERANCE_MS = 90_000;
/** L1 to Earth, km. The spacecraft sit within about +-5% of this, i.e. +-2-3 min of delay. */
export const L1_DISTANCE_KM = 1_500_000;
/** Window for the driver means, as the magnetopause models were fitted. */
export const MEAN_WINDOW_MS = 5 * 60_000;
/** A propagated sample older than this at Earth means the series has a gap. */
const ARRIVAL_MAX_AGE_MS = 15 * 60_000;

const finite = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** SWPC time_tags are UTC but carry no zone ("2026-10-10 12:00:00.000"). */
export function swpcTimeMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) text = `${text.replace(" ", "T")}Z`;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

const triple = (rec: Rec, prefix: string, frame: "gse" | "gsm"): Vector3 | null => {
  const x = finite(rec[`${prefix}x_${frame}`]);
  const y = finite(rec[`${prefix}y_${frame}`]);
  const z = finite(rec[`${prefix}z_${frame}`]);
  return x === null || y === null || z === null ? null : vec(x, y, z);
};

interface WindRec {
  t: number;
  source: string;
  active: boolean;
  density: number;
  speed: number;
  velocityGse: Vector3;
  velocityGsm: Vector3 | null;
}

interface MagRec {
  t: number;
  source: string;
  active: boolean;
  gse: Vector3;
  gsm: Vector3 | null;
  bt: number | null;
}

export function parseWind(data: unknown): WindRec[] {
  if (!Array.isArray(data)) return [];
  const out: WindRec[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Rec;
    const t = swpcTimeMs(rec.time_tag);
    const density = finite(rec.proton_density);
    const speed = finite(rec.proton_speed);
    if (t === null || density === null || speed === null) continue;
    if (density < PLAUSIBLE.densityMin || density > PLAUSIBLE.densityMax) continue;
    if (speed < PLAUSIBLE.speedMin || speed > PLAUSIBLE.speedMax) continue;
    out.push({
      t,
      source: String(rec.source ?? "unknown"),
      active: rec.active === true,
      density,
      speed,
      // Without a published vector the bulk flow is taken as anti-sunward along X.
      velocityGse: triple(rec, "proton_v", "gse") ?? vec(-speed, 0, 0),
      velocityGsm: triple(rec, "proton_v", "gsm"),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function parseMag(data: unknown): MagRec[] {
  if (!Array.isArray(data)) return [];
  const out: MagRec[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Rec;
    const t = swpcTimeMs(rec.time_tag);
    const gse = triple(rec, "b", "gse");
    if (t === null || !gse) continue;
    if (Math.hypot(gse.x, gse.y, gse.z) > PLAUSIBLE.fieldMaxNt) continue;
    out.push({
      t,
      source: String(rec.source ?? "unknown"),
      active: rec.active === true,
      gse,
      gsm: triple(rec, "b", "gsm"),
      bt: finite(rec.bt),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

const minute = (t: number) => Math.floor(t / 60_000);

/**
 * One sample per minute from one spacecraft, so density never jumps between
 * instruments that disagree: the active one, or, if it has no valid wind data
 * (none active, or only fills), the spacecraft with the newest valid record.
 * Each is paired with the nearest mag record within 90 s, same spacecraft first.
 */
export function buildL1Series(windData: unknown, magData: unknown): L1Sample[] {
  const wind = parseWind(windData);
  const mag = parseMag(magData);
  if (wind.length === 0 || mag.length === 0) return [];

  const anyActive = wind.some((w) => w.active);
  const fallbackSource = wind[wind.length - 1].source;
  const primary = new Map<number, WindRec>();
  for (const w of wind) {
    if (anyActive ? !w.active : w.source !== fallbackSource) continue;
    primary.set(minute(w.t), w); // ascending order: the latest in a minute wins
  }

  const magByMinute = new Map<number, MagRec[]>();
  for (const m of mag) {
    const k = minute(m.t);
    if (!magByMinute.has(k)) magByMinute.set(k, []);
    magByMinute.get(k)!.push(m);
  }
  const nearestMag = (t: number, pick: (m: MagRec) => boolean): MagRec | null => {
    let best: MagRec | null = null;
    for (let k = minute(t) - 2; k <= minute(t) + 2; k += 1) {
      for (const m of magByMinute.get(k) ?? []) {
        if (Math.abs(m.t - t) > PAIR_TOLERANCE_MS || !pick(m)) continue;
        if (!best || Math.abs(m.t - t) < Math.abs(best.t - t)) best = m;
      }
    }
    return best;
  };

  const series: L1Sample[] = [];
  for (const w of [...primary.values()].sort((a, b) => a.t - b.t)) {
    const m =
      nearestMag(w.t, (x) => x.source === w.source) ?? nearestMag(w.t, (x) => x.active) ?? nearestMag(w.t, () => true);
    if (!m) continue;
    series.push({
      t: Math.min(w.t, m.t),
      spacecraft: w.source,
      density: w.density,
      speed: w.speed,
      velocityGse: w.velocityGse,
      velocityGsm: w.velocityGsm,
      magneticFieldGse: m.gse,
      magneticFieldGsm: m.gsm,
      bt: m.bt,
    });
  }
  return series;
}

/** `ratio` is spacecraft / reference, median over the window. */
export type DensityCheck = DensityDisagreement;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Compare the operational spacecraft's density with every other spacecraft over
 * the last `windowMs`, minute by minute. Returns the largest disagreement beyond
 * a factor of `tolerance`, or null when they agree (or can't be compared).
 * Speed and field agree to a few percent between spacecraft; density has been
 * seen to differ by 5x, which moves the magnetopause by about a quarter.
 */
export function checkDensity(
  windData: unknown,
  spacecraft: string,
  endMs: number,
  windowMs = 30 * 60_000,
  tolerance = 2,
): DensityCheck | null {
  const endMin = minute(endMs);
  const span = Math.round(windowMs / 60_000);
  const wind = parseWind(windData).filter((w) => minute(w.t) > endMin - span && minute(w.t) <= endMin);
  const bySource = new Map<string, Map<number, number>>();
  for (const w of wind) {
    if (!bySource.has(w.source)) bySource.set(w.source, new Map());
    bySource.get(w.source)!.set(minute(w.t), w.density);
  }
  const own = bySource.get(spacecraft);
  if (!own) return null;
  let worst: DensityCheck | null = null;
  for (const [source, series] of bySource) {
    if (source === spacecraft) continue;
    const pairs = [...own].filter(([m]) => series.has(m)).map(([m, d]) => [d, series.get(m)!] as const);
    // Need half the window in common so a few stray valid minutes can't decide it.
    if (pairs.length < Math.max(10, windowMs / 60_000 / 2)) continue;
    const ratio = median(pairs.map(([a, b]) => a / b));
    if (ratio >= 1 / tolerance && ratio <= tolerance) continue;
    if (!worst || Math.abs(Math.log(ratio)) > Math.abs(Math.log(worst.ratio))) {
      worst = {
        spacecraft,
        density: median(pairs.map(([a]) => a)),
        reference: source,
        referenceDensity: median(pairs.map(([, b]) => b)),
        ratio,
        minutes: pairs.length,
      };
    }
  }
  return worst;
}

/** nPa from cm^-3 and km/s (protons only, as NOAA publishes it). */
export const dynamicPressureNpa = (density: number, speed: number) => 1.6726e-6 * density * speed * speed;

/** Ballistic L1 -> Earth travel time, s, from the sunward component of the flow. */
export function travelSeconds(s: L1Sample): number {
  const vx = Math.abs(s.velocityGse.x) >= PLAUSIBLE.speedMin ? Math.abs(s.velocityGse.x) : s.speed;
  return L1_DISTANCE_KM / vx;
}

export interface DriverMean {
  /** Last measurement in the window. */
  observedAt: string;
  spacecraft: string;
  samples: number;
  /** GSM, nT. */
  bz: number;
  by: number;
  density: number;
  speed: number;
  dynamicPressure: number;
}

/** Mean of the samples measured in (endMs - windowMs, endMs]; GSM from `toGsm` when not published. */
export function meanDrivers(
  series: L1Sample[],
  endMs: number,
  toGsm: (v: Vector3, iso: string) => Vector3,
  windowMs = MEAN_WINDOW_MS,
): DriverMean | null {
  const win = series.filter((s) => s.t > endMs - windowMs && s.t <= endMs);
  if (win.length === 0) return null;
  let bz = 0;
  let by = 0;
  let density = 0;
  let speed = 0;
  let pdyn = 0;
  for (const s of win) {
    const b = s.magneticFieldGsm ?? toGsm(s.magneticFieldGse, new Date(s.t).toISOString());
    bz += b.z;
    by += b.y;
    density += s.density;
    speed += s.speed;
    pdyn += dynamicPressureNpa(s.density, s.speed);
  }
  const n = win.length;
  const last = win[n - 1];
  return {
    observedAt: new Date(last.t).toISOString(),
    spacecraft: last.spacecraft,
    samples: n,
    bz: bz / n,
    by: by / n,
    density: density / n,
    speed: speed / n,
    dynamicPressure: pdyn / n,
  };
}

export type ArrivingDrivers = ArrivingSolarWind;

/**
 * The solar wind reaching Earth now: the newest L1 sample whose ballistic
 * arrival time has passed, as a 5-min mean ending at that sample. Null when
 * the series doesn't reach back far enough or has a gap at that point.
 */
export function arrivingNow(
  series: L1Sample[],
  nowMs: number,
  toGsm: (v: Vector3, iso: string) => Vector3,
): ArrivingDrivers | null {
  let best: { s: L1Sample; arrival: number } | null = null;
  for (const s of series) {
    const arrival = s.t + travelSeconds(s) * 1000;
    // Faster wind can overtake slower wind; take the latest-measured that has arrived.
    if (arrival <= nowMs && (!best || s.t > best.s.t)) best = { s, arrival };
  }
  if (!best || nowMs - best.arrival > ARRIVAL_MAX_AGE_MS) return null;
  const mean = meanDrivers(series, best.s.t, toGsm);
  if (!mean) return null;
  return { ...mean, arrivedAt: new Date(best.arrival).toISOString(), travelSeconds: travelSeconds(best.s) };
}
