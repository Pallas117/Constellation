/**
 * Guided storm walkthrough (GAU-229): staff training on the pilot story, played from a real
 * storm replayed through the live pipeline (backend/replay/walkthrough.ts writes the data).
 *
 * The stops are found in the data, not typed in, and every number in their text is read from
 * the sample at that moment, so the words can't drift from what the scene shows.
 */
import type { SolarWindDrivers, Vec3 } from '../physics/geomagnetic.ts';
import { shueMagnetopause, gsmToScene } from '../physics/geomagnetic.ts';
import type { LiveDrivers } from '../physics/live-drivers.ts';
import { circularOrbitGei, geiToGsm, insideOutline, subSatellitePoint, RE_KM, type CircularOrbit } from '../physics/frames.ts';

/* Shape of frontend/src/data/walkthrough/<id>.json (backend/replay/walkthrough.ts). */
export interface WalkthroughWind {
  bz: number;
  by: number;
  pdyn: number;
  speed: number;
  density: number;
}
export interface WalkthroughSample {
  t: string;
  l1: WalkthroughWind;
  spacecraft: string | null;
  arriving: (WalkthroughWind & { travelMin: number; spacecraft: string }) | null;
  kp: number | null;
  kpKind: string | null;
  dst: number;
  dstMethod: string;
  S: string;
  G: string;
  R: string;
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
  inputsSha256: string;
  recordsSha256: string;
  saa: {
    altKm: number;
    epoch: string;
    model: string;
    core: [number, number][];
    extended: [number, number][];
    minimum: { lat: number; lon: number; nT: number };
    thresholds: { coreNt: number; extendedNt: number; source: string };
  };
  samples: WalkthroughSample[];
}

/** GEO in Earth radii (as SceneHoverTip). */
const GEO_RE = 6.6;

/** The sample in force at `ms`: the latest at or before it (no interpolation between measurements). */
export function sampleIndexAt(data: WalkthroughData, ms: number): number {
  const { samples } = data;
  let lo = 0;
  let hi = samples.length - 1;
  if (ms <= Date.parse(samples[0].t)) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Date.parse(samples[mid].t) <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The solar wind driving the scene: what reached Earth (propagated) when known, else the latest L1 reading. */
export function windAtEarth(s: WalkthroughSample): { wind: WalkthroughWind; propagated: boolean } {
  return s.arriving ? { wind: s.arriving, propagated: true } : { wind: s.l1, propagated: false };
}

export function sceneDrivers(s: WalkthroughSample): SolarWindDrivers {
  const { wind } = windAtEarth(s);
  return { bz: wind.bz, by: wind.by, pdyn: wind.pdyn, kp: s.kp };
}

/** The dashboard's drivers object for a replayed moment: labelled replay, never live. */
export function replayDrivers(s: WalkthroughSample): LiveDrivers {
  const { wind, propagated } = windAtEarth(s);
  const t = Date.parse(s.t);
  const kpKind = s.kpKind === 'estimated-1m' || s.kpKind === 'planetary-3h' ? s.kpKind : 'unknown';
  return {
    mode: 'replay',
    ageMin: null,
    drivers: sceneDrivers(s),
    plasma: { speed: wind.speed, density: wind.density },
    propagated,
    arriving: s.arriving
      ? {
          observedAt: new Date(t - s.arriving.travelMin * 60_000).toISOString(),
          travelMin: s.arriving.travelMin,
          spacecraft: s.arriving.spacecraft,
        }
      : null,
    l1: { observedAt: s.t, ...s.l1, etaEarth: null },
    densityCheck: null,
    kp: s.kp === null ? null : { value: s.kp, kind: kpKind },
  };
}

/** Magnetopause stand-off from the sample's drivers (the scene traces the same Shue model). */
export function standoff(s: WalkthroughSample): { r0: number; extrapolated: boolean } {
  const { wind } = windAtEarth(s);
  const { r0 } = shueMagnetopause(wind.bz, wind.pdyn);
  return { r0, extrapolated: wind.bz < -18 || wind.bz > 15 || wind.pdyn < 0.5 || wind.pdyn > 8.5 };
}

/**
 * The teaching satellite: a circular 400 km, 51.6° orbit, inside the band where the SAA flag
 * applies (backend/trust/saa.ts, 300–450 km). Illustrative, not a real spacecraft.
 */
export function teachingOrbit(data: WalkthroughData): CircularOrbit {
  return { altKm: data.saa.altKm, inclinationDeg: 51.6, raanDeg: 0, epochMs: Date.parse(data.start) };
}

export function inSaa(data: WalkthroughData, ms: number): 'core' | 'extended' | null {
  const p = subSatellitePoint(teachingOrbit(data), ms);
  if (insideOutline(p.lat, p.lon, data.saa.core)) return 'core';
  if (insideOutline(p.lat, p.lon, data.saa.extended)) return 'extended';
  return null;
}

/** First moment at or after `fromMs` when the teaching satellite is inside the SAA core (30 s steps). */
export function nextSaaPass(data: WalkthroughData, fromMs: number, withinMs = 6 * 3_600_000): number | null {
  for (let t = fromMs; t <= fromMs + withinMs; t += 30_000) if (inSaa(data, t) === 'core') return t;
  return null;
}

export interface CameraGoal {
  position: Vec3;
  target: Vec3;
  /** Closest the controls may zoom while this stop is shown. */
  minDistance?: number;
}

export interface WalkthroughStop {
  id: 'quiet' | 'shock' | 'squeeze' | 'saa' | 'peak' | 'pilot';
  title: string;
  atMs: number;
  camera: CameraGoal;
  /** Two or three sentences; numbers come from the data. */
  body: string;
  showSaa: boolean;
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const n0 = (v: number) => Math.round(v).toString();
const n1 = (v: number) => v.toFixed(1);
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;

const at = (data: WalkthroughData, i: number) => Date.parse(data.samples[i].t);

/** Index of the first sample where L1 speed jumps by `jump` km/s from the one before. */
function shockIndex(data: WalkthroughData, jump = 100): number {
  const s = data.samples;
  for (let i = 1; i < s.length; i++) if (s[i].l1.speed - s[i - 1].l1.speed >= jump) return i;
  return -1;
}

function argmax(data: WalkthroughData, value: (s: WalkthroughSample) => number, from = 0): number {
  let best = from;
  for (let i = from; i < data.samples.length; i++) if (value(data.samples[i]) > value(data.samples[best])) best = i;
  return best;
}

/**
 * The six stops, found in the data. Throws when the data lacks a shock, so a different storm
 * can't silently get May 2024's story.
 */
export function buildStops(data: WalkthroughData): WalkthroughStop[] {
  const s = data.samples;
  const first = s[0];
  const quiet = standoff(first);

  const shock = shockIndex(data);
  if (shock < 1) throw new Error(`${data.id}: no solar wind shock at L1 in the replay`);
  const before = s[shock - 1].l1;
  const after = s[shock].l1;
  const arrive = s.findIndex((x, i) => i > shock && x.arriving !== null && x.arriving.pdyn >= 10);

  const squeeze = argmax(data, (x) => x.arriving?.pdyn ?? -1);
  const sq = s[squeeze];
  const sqStand = standoff(sq);
  const sqWind = windAtEarth(sq).wind;

  const peak = argmax(data, (x) => -x.dst);
  const pk = s[peak];
  const g5 = s.findIndex((x) => x.G === 'G5');
  const saaAt = nextSaaPass(data, g5 >= 0 ? at(data, g5) : at(data, peak)) ?? at(data, peak);

  // Camera just outside the teaching satellite as it crosses the anomaly, looking at it.
  const orbit = teachingOrbit(data);
  const sat = gsmToScene(
    (() => {
      const g = geiToGsm(circularOrbitGei(orbit, saaAt), saaAt);
      const r = 1 + orbit.altKm / RE_KM;
      return [g[0] * r, g[1] * r, g[2] * r] as Vec3;
    })(),
  );
  const len = Math.hypot(...sat);
  const saaCamera: Vec3 = [(sat[0] / len) * 3.0 + 0.5, (sat[1] / len) * 3.0 + 0.9, (sat[2] / len) * 3.0];

  return [
    {
      id: 'quiet',
      title: 'Before the storm',
      atMs: at(data, 0),
      camera: { position: [24, 6, 14], target: [3, 0, 0] },
      body:
        `${hhmm(at(data, 0))} UT, ${day(at(data, 0))}. Solar wind at Earth ${n0(windAtEarth(first).wind.speed)} km/s, Bz ${signed(
          windAtEarth(first).wind.bz,
        )} nT, Kp ${first.kp ?? '—'}. ` +
        `The magnetopause, where Earth's field holds the wind off, stands about ${n1(quiet.r0)} Earth radii out` +
        (quiet.r0 > GEO_RE ? ', well beyond geostationary orbit (6.6).' : '.'),
      showSaa: false,
    },
    {
      id: 'shock',
      title: 'A shock reaches L1',
      atMs: at(data, shock),
      camera: { position: [30, 9, -10], target: [6, 0, 0] },
      body:
        `At ${hhmm(at(data, shock))} UT the spacecraft at L1, 1.5 million km sunward, sees the wind jump from ${n0(
          before.speed,
        )} to ${n0(after.speed)} km/s and its density from ${n1(before.density)} to ${n1(after.density)} cm⁻³: ` +
        `the kind of shock a coronal mass ejection drives.` +
        (arrive > 0 ? ` Propagated to Earth, it arrives at about ${hhmm(at(data, arrive))} UT.` : ''),
      showSaa: false,
    },
    {
      id: 'squeeze',
      title: 'The shield is pushed in',
      atMs: at(data, squeeze),
      camera: { position: [-3, 4, 24], target: [2, 0, 0] },
      body:
        `${hhmm(at(data, squeeze))} UT: pressure reaching Earth peaks at ${n1(sqWind.pdyn)} nPa with Bz ${signed(sqWind.bz)} nT. ` +
        `The magnetopause is pushed in to about ${n1(sqStand.r0)} Earth radii` +
        (sqStand.extrapolated ? ' (extrapolated: the model was fitted to calmer wind)' : '') +
        (sqStand.r0 < GEO_RE
          ? '. Inside 6.6, satellites in geostationary orbit find themselves outside the shield, in the solar wind itself.'
          : '.'),
      showSaa: false,
    },
    {
      id: 'saa',
      title: 'The belts and the South Atlantic Anomaly',
      atMs: saaAt,
      camera: { position: saaCamera, target: [sat[0] * 0.8, sat[1] * 0.8, sat[2] * 0.8] },
      body:
        `Over the South Atlantic the field at ${data.saa.altKm} km is weakest (${n0(data.saa.minimum.nT)} nT, ${data.saa.model}), ` +
        `so the inner proton belt reaches down to low orbits. This teaching satellite (${data.saa.altKm} km, 51.6°, drawn far larger than life) ` +
        `crosses it at ${hhmm(saaAt)} UT. The anomaly is there in quiet times too: it is where upsets in low-orbit electronics cluster.`,
      showSaa: true,
    },
    {
      id: 'peak',
      title: 'Storm peak',
      atMs: at(data, peak),
      camera: { position: [-12, 17, 13], target: [-3, 0, 0] },
      body:
        `${hhmm(at(data, peak))} UT, ${day(at(data, peak))}. Kp ${pk.kp ?? '—'} (${pk.G}). Gauss's ring-current estimate (${pk.dstMethod.replace(/^model: /, '').replace(/ ring-current$/, '')}) bottoms out at ${signed(pk.dst)} nT. ` +
        `The auroral oval drawn from Kp reaches its lowest latitude.`,
      showSaa: false,
    },
    {
      id: 'pilot',
      title: 'What a pilot does with this',
      atMs: at(data, s.length - 1),
      camera: { position: [6, 5, 18], target: [0, 0, 0] },
      body:
        `Every minute of this storm is now a record: the S, G and R levels, the input checks, and what reached Earth when. ` +
        `A replay pilot lines a customer's own logs up against records like these, minute by minute.`,
      showSaa: false,
    },
  ];
}

/** The stop in force at `ms`: the last one at or before it. */
export function stopIndexAt(stops: readonly WalkthroughStop[], ms: number): number {
  let i = 0;
  for (let k = 0; k < stops.length; k++) if (stops[k].atMs <= ms) i = k;
  return i;
}
