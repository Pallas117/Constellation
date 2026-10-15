import { fetchJsonConditional } from "../lib/conditional-fetch.js";
import type { DataSource, ParticleReading, SourceStatus } from "../types.js";

const SOURCE: DataSource = "goes-swpc";

// SWPC GOES primary-satellite integral flux, 5-minute cadence.
const PROTONS_URL = "https://services.swpc.noaa.gov/json/goes/primary/integral-protons-6-hour.json";
const ELECTRONS_URL = "https://services.swpc.noaa.gov/json/goes/primary/integral-electrons-6-hour.json";

/** NOAA S-scale channel (pfu = particles cm^-2 s^-1 sr^-1). */
export const PROTON_CHANNEL = ">=10 MeV";
/** Radiation-belt "killer electron" channel used for GEO charging alerts. */
export const ELECTRON_CHANNEL = ">=2 MeV";
/** GOES publishes every 5 min; beyond this a reading is unknown, not current. */
export const PARTICLE_MAX_AGE_MS = 30 * 60 * 1000;

export interface GoesParticleReadout {
  protons: ParticleReading | null;
  electrons: ParticleReading | null;
}

let latestStatus: SourceStatus = {
  source: SOURCE,
  lastSeen: null,
  latencySeconds: null,
  healthy: false,
  message: "Not fetched yet",
};

/**
 * Newest valid sample for one energy channel. GOES fill values are negative and some rows carry
 * null or non-numeric flux; those are skipped rather than read as 0.
 */
export function pickChannel(data: unknown, energy: string): ParticleReading | null {
  if (!Array.isArray(data)) return null;
  let best: ParticleReading | null = null;
  let bestMs = -Infinity;
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.energy !== energy) continue;
    const flux = typeof rec.flux === "number" ? rec.flux : Number.NaN;
    if (!Number.isFinite(flux) || flux < 0) continue;
    const ms = typeof rec.time_tag === "string" ? Date.parse(rec.time_tag) : Number.NaN;
    if (!Number.isFinite(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = {
      value: flux,
      energy,
      satellite: typeof rec.satellite === "number" ? `GOES-${rec.satellite}` : null,
      timestamp: new Date(ms).toISOString(),
    };
  }
  return best;
}

/** The reading if it is younger than PARTICLE_MAX_AGE_MS at `nowMs`, otherwise null (unknown). */
export function freshReading(reading: ParticleReading | null, nowMs: number): ParticleReading | null {
  if (!reading) return null;
  const age = nowMs - Date.parse(reading.timestamp);
  return age >= 0 && age <= PARTICLE_MAX_AGE_MS ? reading : null;
}

// Conditional GETs, so the 20 s poll costs a 304 until the 5-minute product changes.
const fetchJson = (url: string, label: string): Promise<unknown> =>
  fetchJsonConditional(url, `GOES ${label} feed`);

export async function fetchGoesParticles(nowMs = Date.now()): Promise<GoesParticleReadout | null> {
  try {
    const [protonData, electronData] = await Promise.all([
      fetchJson(PROTONS_URL, "proton"),
      fetchJson(ELECTRONS_URL, "electron"),
    ]);
    const readout: GoesParticleReadout = {
      protons: pickChannel(protonData, PROTON_CHANNEL),
      electrons: pickChannel(electronData, ELECTRON_CHANNEL),
    };

    const times = [readout.protons, readout.electrons]
      .filter((r): r is ParticleReading => r !== null)
      .map((r) => Date.parse(r.timestamp));
    // Report the older channel so freshness is never overstated.
    const oldest = times.length > 0 ? Math.min(...times) : null;
    const fresh = freshReading(readout.protons, nowMs) !== null && freshReading(readout.electrons, nowMs) !== null;
    latestStatus = {
      source: SOURCE,
      lastSeen: oldest !== null ? new Date(oldest).toISOString() : latestStatus.lastSeen,
      latencySeconds: oldest !== null ? Math.max(0, Math.round((nowMs - oldest) / 1000)) : latestStatus.latencySeconds,
      healthy: fresh,
      message: fresh
        ? `GOES protons ${PROTON_CHANNEL} and electrons ${ELECTRON_CHANNEL} current`
        : "GOES particle channels missing or older than 30 min",
    };
    return readout;
  } catch (error) {
    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.latencySeconds,
      healthy: false,
      message: error instanceof Error && error.name === "TimeoutError"
        ? "GOES particle feed timed out"
        : error instanceof Error ? error.message : "GOES particle fetch failed",
    };
    return null;
  }
}

export function getGoesStatus(): SourceStatus {
  return latestStatus;
}
