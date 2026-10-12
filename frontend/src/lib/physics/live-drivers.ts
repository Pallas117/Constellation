/**
 * Turns the latest L1 reading into what the scene and HUD show, failing
 * closed: without a reading there are no drivers (reference geometry) and
 * the readouts show "—", never nominal numbers presented as live.
 */
import type { SolarWindDrivers } from './geomagnetic.ts';
import type { CanonicalSpaceWeatherPoint } from '../types/space-weather.ts';

export type FeedMode = 'live' | 'stale' | 'none' | 'simulated';

/** Older than this, a reading is shown as stale. */
export const STALE_AFTER_MIN = 15;

/** Simulated G4: strong southward IMF behind a CME shock (Pdyn = 1.67e-6·n·v² ≈ 15 nPa). */
export const G4_DRIVERS: SolarWindDrivers = { bz: -20, by: 6, pdyn: 15, kp: 8 };
export const G4_PLASMA = { speed: 670, density: 20 };

export interface LiveDrivers {
  mode: FeedMode;
  /** Minutes since the reading's timestamp; null when unknown or simulated. */
  ageMin: number | null;
  drivers: SolarWindDrivers | undefined;
  plasma: { speed: number; density: number } | null;
}

export function liveDrivers(
  latest: CanonicalSpaceWeatherPoint | null,
  nowMs: number,
  simulate = false,
): LiveDrivers {
  if (simulate) return { mode: 'simulated', ageMin: null, drivers: G4_DRIVERS, plasma: G4_PLASMA };
  if (!latest) return { mode: 'none', ageMin: null, drivers: undefined, plasma: null };

  const age = (nowMs - Date.parse(latest.timestamp)) / 60_000;
  const known = Number.isFinite(age);
  const stale = latest.quality.stale || !known || age > STALE_AFTER_MIN;
  return {
    mode: stale ? 'stale' : 'live',
    ageMin: known ? Math.max(0, age) : null,
    drivers: {
      bz: latest.magneticField.z,
      by: latest.magneticField.y,
      pdyn: latest.solarWind.dynamicPressure,
      kp: latest.indices.kp,
    },
    plasma: { speed: latest.solarWind.speed, density: latest.solarWind.density },
  };
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
