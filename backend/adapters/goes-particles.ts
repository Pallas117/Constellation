import { checkChannelRows, checkProtonSpectrum } from "../lib/sense-checks.js";
import { XRAY_BAND, flareClass } from "../physics/noaa-scales.js";
import type { DataSource, ParticleReading, SenseCheck, SourceStatus, XrayReading } from "../types.js";
import { SWPC_ORIGIN } from "./swpc-fetch.js";

const SOURCE: DataSource = "goes-swpc";

// SWPC GOES primary-satellite integral flux, 5-minute cadence.
const PROTONS_URL = "https://services.swpc.noaa.gov/json/goes/primary/integral-protons-6-hour.json";
const ELECTRONS_URL = "https://services.swpc.noaa.gov/json/goes/primary/integral-electrons-6-hour.json";
// 1-minute X-ray irradiance, two bands; the 0.1-0.8 nm (1-8 Å) band defines flare class and the R-scale.
const XRAYS_URL = `${SWPC_ORIGIN}/json/goes/primary/xrays-6-hour.json`;

/** NOAA S-scale channel (pfu = particles cm^-2 s^-1 sr^-1). */
export const PROTON_CHANNEL = ">=10 MeV";
/** Radiation-belt "killer electron" channel used for GEO charging alerts. */
export const ELECTRON_CHANNEL = ">=2 MeV";
/** GOES publishes every 5 min; beyond this a reading is unknown, not current. */
export const PARTICLE_MAX_AGE_MS = 30 * 60 * 1000;
/** Channels compared for a monotonic integral spectrum (GAU-136). */
export const SPECTRUM_CHANNELS = [">=10 MeV", ">=50 MeV", ">=100 MeV"] as const;
/** GOES X-rays publish every minute; a flare's rise takes minutes, so beyond this the reading is unknown. */
export const XRAY_MAX_AGE_MS = 15 * 60 * 1000;

export interface GoesParticleReadout {
  protons: ParticleReading | null;
  electrons: ParticleReading | null;
  /** Newest long-band X-ray reading; null when the X-ray feed had none. */
  xray?: XrayReading | null;
  /** Spectrum, channel and X-ray sense-checks from this fetch (GAU-136). */
  checks?: SenseCheck[];
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

/**
 * The SPECTRUM_CHANNELS readings at the newest GOES time step that has at least two of them,
 * in increasing energy (null where a channel has no valid value at that step).
 */
export function spectrumAt(data: unknown, channels: readonly string[] = SPECTRUM_CHANNELS): Array<ParticleReading | null> {
  const byTime = new Map<string, unknown[]>();
  if (Array.isArray(data)) {
    for (const item of data) {
      const t = item && typeof item === "object" ? (item as Record<string, unknown>).time_tag : null;
      if (typeof t !== "string") continue;
      if (!byTime.has(t)) byTime.set(t, []);
      byTime.get(t)!.push(item);
    }
  }
  const times = [...byTime.keys()].filter((t) => Number.isFinite(Date.parse(t))).sort((a, b) => Date.parse(b) - Date.parse(a));
  for (const t of times) {
    const step = channels.map((energy) => pickChannel(byTime.get(t), energy));
    if (step.filter((r) => r !== null).length >= 2) return step;
  }
  return channels.map(() => null);
}

/** Newest valid long-band X-ray sample; fills (negative, null) are skipped, as for particles. */
export function pickXray(data: unknown): XrayReading | null {
  // Unlike a particle count, an X-ray irradiance of exactly 0 is not physical: treat it as a fill.
  const rows = Array.isArray(data) ? data.filter((r) => r && typeof r === "object" && (r as Record<string, unknown>).flux !== 0) : data;
  const reading = pickChannel(rows, XRAY_BAND);
  return reading
    ? { value: reading.value, band: XRAY_BAND, flareClass: flareClass(reading.value), satellite: reading.satellite, timestamp: reading.timestamp }
    : null;
}

/** Fill and flat-line checks on the X-ray band, plus NOAA's own electron-contamination flag on the newest sample. */
export function checkXray(data: unknown): SenseCheck {
  const check = checkChannelRows(data, [XRAY_BAND], "goes-xray", "W/m²");
  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  const newest = rows
    .filter((r) => r && r.energy === XRAY_BAND && typeof r.time_tag === "string")
    .sort((a, b) => Date.parse(b.time_tag as string) - Date.parse(a.time_tag as string))[0];
  if (newest?.electron_contaminaton === true) {
    return {
      ...check,
      status: "flag",
      reason: `NOAA marks the newest ${XRAY_BAND} sample as electron-contaminated (corrected flux shown); ${check.reason}`,
    };
  }
  return check;
}

/** The reading if it is younger than PARTICLE_MAX_AGE_MS at `nowMs`, otherwise null (unknown). */
export function freshReading(reading: ParticleReading | null, nowMs: number): ParticleReading | null {
  if (!reading) return null;
  const age = nowMs - Date.parse(reading.timestamp);
  return age >= 0 && age <= PARTICLE_MAX_AGE_MS ? reading : null;
}

/** The X-ray reading if it is younger than XRAY_MAX_AGE_MS at `nowMs`, otherwise null (unknown). */
export function freshXray(reading: XrayReading | null, nowMs: number): XrayReading | null {
  if (!reading) return null;
  const age = nowMs - Date.parse(reading.timestamp);
  return age >= 0 && age <= XRAY_MAX_AGE_MS ? reading : null;
}

async function fetchJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    throw new Error(`GOES ${label} feed returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchGoesParticles(nowMs = Date.now()): Promise<GoesParticleReadout | null> {
  try {
    const [protonData, electronData, xrayData] = await Promise.all([
      fetchJson(PROTONS_URL, "proton"),
      fetchJson(ELECTRONS_URL, "electron"),
      // X-rays only feed the R-scale and their own check; their failure doesn't fail the particles.
      fetchJson(XRAYS_URL, "X-ray").catch(() => undefined),
    ]);
    const readout: GoesParticleReadout = {
      protons: pickChannel(protonData, PROTON_CHANNEL),
      electrons: pickChannel(electronData, ELECTRON_CHANNEL),
      xray: xrayData === undefined ? null : pickXray(xrayData),
      checks: [
        checkProtonSpectrum(spectrumAt(protonData)),
        checkChannelRows(protonData, SPECTRUM_CHANNELS, "goes-proton-channels", "pfu"),
        xrayData === undefined
          ? { id: "goes-xray", status: "unknown", reason: "GOES X-ray feed unavailable", observedAt: null }
          : checkXray(xrayData),
      ],
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
      // The data keeps ageing while fetches fail: never report the last fetch's age as current.
      latencySeconds: latestStatus.lastSeen
        ? Math.max(0, Math.round((nowMs - Date.parse(latestStatus.lastSeen)) / 1000))
        : null,
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
