/**
 * Turns the latest point into what the scene and HUD show, failing closed:
 * without a usable measurement there are no drivers (reference geometry) and
 * the readouts show "—", never nominal numbers presented as live.
 *
 * The magnetosphere responds to the solar wind reaching Earth, which L1
 * measured one travel time (~45 min) ago. The backend propagates the L1
 * series and sends that as `arriving` (a 5-min mean); the latest L1 reading
 * is what is coming next.
 */
import type { SolarWindDrivers } from './geomagnetic.ts';
import type { CanonicalSpaceWeatherPoint, DensityDisagreement } from '../types/space-weather.ts';

/**
 * live: L1 measured within 10 min. transit: the L1 feed is late, but measured
 * solar wind is still arriving at Earth. stale: L1 10-15 min old, nothing
 * propagated. none: nothing usable.
 */
export type FeedMode = 'live' | 'transit' | 'stale' | 'none' | 'simulated';

/** Measurements fresher than this are live (the backend's NOAA_FRESH_MS). */
export const FRESH_MIN = 10;
/** Older than this, a measurement is not shown (the backend's NOAA_MAX_AGE_MS). */
export const STALE_AFTER_MIN = 15;

/** Simulated G4: strong southward IMF behind a CME shock (Pdyn = 1.67e-6·n·v² ≈ 15 nPa). */
export const G4_DRIVERS: SolarWindDrivers = { bz: -20, by: 6, pdyn: 15, kp: 8 };
export const G4_PLASMA = { speed: 670, density: 20 };

export interface L1Reading {
  observedAt: string;
  bz: number;
  by: number;
  pdyn: number;
  speed: number;
  density: number;
  /** When this reading reaches Earth. */
  etaEarth: string | null;
}

export interface LiveDrivers {
  mode: FeedMode;
  /** Minutes since the latest L1 measurement; null when unknown or simulated. */
  ageMin: number | null;
  /** Drivers for the field model. */
  drivers: SolarWindDrivers | undefined;
  /** Plasma behind those drivers. */
  plasma: { speed: number; density: number } | null;
  /** Drivers are the propagated at-Earth 5-min mean (don't average them again). */
  propagated: boolean;
  /** When the solar wind now at Earth was measured at L1, and its travel time. */
  arriving: { observedAt: string; travelMin: number; spacecraft: string } | null;
  /** The latest L1 reading: what reaches Earth next. Null when too old to show. */
  l1: L1Reading | null;
  densityCheck: DensityDisagreement | null;
  kp: { value: number; kind: 'estimated-1m' | 'planetary-3h' | 'unknown' } | null;
}

const NONE: LiveDrivers = {
  mode: 'none',
  ageMin: null,
  drivers: undefined,
  plasma: null,
  propagated: false,
  arriving: null,
  l1: null,
  densityCheck: null,
  kp: null,
};

export function liveDrivers(latest: CanonicalSpaceWeatherPoint | null, nowMs: number, simulate = false): LiveDrivers {
  if (simulate) {
    return { ...NONE, mode: 'simulated', drivers: G4_DRIVERS, plasma: G4_PLASMA };
  }
  if (!latest) return NONE;

  const measured = Date.parse(latest.observedAt ?? latest.timestamp);
  const age = (nowMs - measured) / 60_000;
  const known = Number.isFinite(age);
  const backendStale = latest.quality.stale || latest.quality.tier === 3;
  const l1Fresh = known && !backendStale && age <= FRESH_MIN;
  const l1Usable = known && !backendStale && age <= STALE_AFTER_MIN;

  const a = latest.arriving;
  const arrivedAgo = a ? (nowMs - Date.parse(a.arrivedAt)) / 60_000 : NaN;
  // The backend drops a propagated sample 15 min after it arrived; so does the client clock.
  const arrivingOk = Boolean(a) && Number.isFinite(arrivedAgo) && arrivedAgo <= STALE_AFTER_MIN;

  const kp = { value: latest.indices.kp, kind: latest.indices.kpKind ?? ('unknown' as const) };
  const l1: L1Reading | null = l1Usable
    ? {
        observedAt: new Date(measured).toISOString(),
        bz: latest.magneticField.z,
        by: latest.magneticField.y,
        pdyn: latest.solarWind.dynamicPressure,
        speed: latest.solarWind.speed,
        density: latest.solarWind.density,
        etaEarth: latest.propagation?.etaEarthArrival ?? null,
      }
    : null;
  const base = {
    ageMin: known ? Math.max(0, age) : null,
    l1,
    densityCheck: latest.densityCheck ?? null,
    kp,
  };

  if (arrivingOk && a) {
    return {
      ...base,
      mode: l1Fresh ? 'live' : 'transit',
      drivers: { bz: a.bz, by: a.by, pdyn: a.dynamicPressure, kp: kp.value },
      plasma: { speed: a.speed, density: a.density },
      propagated: true,
      arriving: { observedAt: a.observedAt, travelMin: a.travelSeconds / 60, spacecraft: a.spacecraft },
    };
  }
  if (l1) {
    // Not propagated yet (or the backend predates propagation): the latest L1 reading,
    // which the scene averages over 5 min itself.
    return {
      ...base,
      mode: l1Fresh ? 'live' : 'stale',
      drivers: { bz: l1.bz, by: l1.by, pdyn: l1.pdyn, kp: kp.value },
      plasma: { speed: l1.speed, density: l1.density },
      propagated: false,
      arriving: null,
    };
  }
  return { ...NONE, ageMin: base.ageMin, densityCheck: base.densityCheck };
}

/** Normalised parameters the radiation belts still use; reference values without drivers. */
export function beltVisuals(drivers: SolarWindDrivers | undefined) {
  const pressure = drivers?.pdyn ?? 2;
  const bz = drivers?.bz ?? 0;
  const kp = drivers?.kp ?? 2;
  return {
    magnetopauseCompression: Math.max(0.6, 1 - Math.min(1, pressure / 10) * 0.4),
    beltIntensity: Math.min(1, kp / 9 + 0.2),
    reconnectionStrength: Math.max(0, Math.min(1, -bz / 15)),
  };
}

/**
 * Magnetopause standoff if the other spacecraft's density is right. Shue (1998)
 * r0 scales as Pdyn^(-1/6.6), and Pdyn scales with density at fixed speed.
 */
export function standoffIfReference(r0: number, check: DensityDisagreement): number {
  return r0 * Math.pow(check.referenceDensity / check.density, -1 / 6.6);
}
