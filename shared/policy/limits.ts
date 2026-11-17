/**
 * Physical plausibility limits for solar-wind and geomagnetic values: one table for every surface
 * (GAU-244; it was a private table in backend/adapters/rtsw-series.ts). A value outside these is an
 * instrument fill, a unit error or a corrupt row, not space weather, so it never becomes a canonical
 * observation. Change a bound here, never a copy of it elsewhere.
 */
export const PLAUSIBLE = {
  /** cm^-3. ACE's degraded SWEPAM reports 0.0-0.1; the quietest solar wind on record is ~0.1-0.2, so lower is a fill. */
  densityMin: 0.1,
  densityMax: 150,
  /** km/s. The legacy buffer (GAU-211) held speeds up to ~64,000 km/s: that is what this bound stops. */
  speedMin: 200,
  speedMax: 3000,
  /** nT, IMF magnitude at L1. */
  fieldMaxNt: 300,
  /** Planetary Kp is defined on 0-9. */
  kpMin: 0,
  kpMax: 9,
  /**
   * nT. Generous on purpose: far outside the instrumental Dst record (-589 nT, March 1989) and the
   * published Carrington-event estimates, so only nonsense is refused, never a real superstorm.
   */
  dstMinNt: -2000,
  dstMaxNt: 500,
} as const;

/** A measurement time may run ahead of the issue time by clock skew only, never more. */
export const OBSERVED_AT_MAX_LEAD_MS = 2 * 60_000;
