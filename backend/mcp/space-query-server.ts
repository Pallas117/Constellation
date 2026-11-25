/**
 * space-query MCP server: wires the existing agency adapters (backend/adapters/) into the read-only core in
 * `space-query.ts` and serves it over stdio. Nothing listens on a port; the AI tool starts the process:
 *
 *     node --import tsx backend/mcp/space-query-server.ts
 *
 * Example client entry (e.g. `.mcp.json`): { "command": "node", "args": ["--import", "tsx", "backend/mcp/space-query-server.ts"] }
 *
 * Network: only the adapters' own fixed agency URLs (outbound HTTPS, TLS as the adapters already use it).
 * No secrets, no env-supplied URLs, no writes, no auth routes. stdout carries JSON-RPC only; logs go to stderr.
 */
import { pathToFileURL } from "node:url";
import { fetchEsaReadout, ESA_MAX_AGE_MS, type ESAReadout } from "../adapters/esa-hapi.js";
import { fetchGoesParticles, PARTICLE_MAX_AGE_MS, type GoesParticleReadout } from "../adapters/goes-particles.js";
import { fetchKyotoDst, DST_MAX_AGE_MS, type DstReading } from "../adapters/kyoto-dst.js";
import { fetchNoaaReadout, RTSW_MAX_AGE_MS, type NOAAReadout } from "../adapters/noaa-swpc.js";
import { freshnessMs } from "../../shared/policy/freshness.js";
import { createSpaceQuery, LIMITS, serveLines, type SpaceRow, type SpaceSource } from "./space-query.js";

const iso = (ms: number) => new Date(ms).toISOString();

/** L1 solar-wind rows from the RTSW readout: the 3 h series when present, else the single paired sample. */
export function l1Rows(r: NOAAReadout | null): SpaceRow[] {
  if (!r) return [];
  if (r.series?.length) {
    return r.series.map((s) => ({
      time: iso(s.t),
      values: {
        spacecraft: s.spacecraft,
        density_cm3: s.density,
        speed_kms: s.speed,
        vx_gse_kms: s.velocityGse.x,
        vy_gse_kms: s.velocityGse.y,
        vz_gse_kms: s.velocityGse.z,
        bx_gse_nt: s.magneticFieldGse.x,
        by_gse_nt: s.magneticFieldGse.y,
        bz_gse_nt: s.magneticFieldGse.z,
        bz_gsm_nt: s.magneticFieldGsm ? s.magneticFieldGsm.z : null,
        bt_nt: s.bt ?? null,
      },
    }));
  }
  return [
    {
      time: r.timestamp,
      values: {
        spacecraft: r.spacecraft,
        density_cm3: r.density,
        speed_kms: Math.hypot(r.velocityGse.x, r.velocityGse.y, r.velocityGse.z),
        vx_gse_kms: r.velocityGse.x,
        vy_gse_kms: r.velocityGse.y,
        vz_gse_kms: r.velocityGse.z,
        bx_gse_nt: r.magneticFieldGse.x,
        by_gse_nt: r.magneticFieldGse.y,
        bz_gse_nt: r.magneticFieldGse.z,
        bz_gsm_nt: r.magneticFieldGsm ? r.magneticFieldGsm.z : null,
        bt_nt: null,
      },
    },
  ];
}

/** Kp as NOAA reports it (1-min estimate or 3-hourly planetary), from the same readout. */
export function kpRows(r: NOAAReadout | null): SpaceRow[] {
  const k = r?.kpReading;
  if (!k || !k.observedAt) return [];
  return [{ time: k.observedAt, values: { kp: k.value, kind: k.kind } }];
}

export function goesRows(r: GoesParticleReadout | null): SpaceRow[] {
  if (!r) return [];
  return [r.protons, r.electrons]
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => ({ time: p.timestamp, values: { channel: p.energy, flux_cm2_s_sr: p.value, satellite: p.satellite } }));
}

export function swarmRows(r: ESAReadout | null): SpaceRow[] {
  if (!r) return [];
  return [
    {
      time: r.timestamp,
      values: {
        b_n_nt: r.magneticFieldNec.x,
        b_e_nt: r.magneticFieldNec.y,
        b_c_nt: r.magneticFieldNec.z,
        b_total_nt: r.fieldMagnitudeNt,
        latitude_deg: r.position?.latitudeDeg ?? null,
        longitude_deg: r.position?.longitudeDeg ?? null,
        altitude_km: r.position?.altitudeKm ?? null,
      },
    },
  ];
}

export function dstRows(r: DstReading | null): SpaceRow[] {
  return r ? [{ time: r.timestamp, values: { dst_nt: r.dst } }] : [];
}

/** One NOAA RTSW fetch serves both L1 and Kp within the cache window. */
function shared<T>(fetcher: (nowMs: number) => Promise<T>): (nowMs: number) => Promise<T> {
  let last: { at: number; value: Promise<T> } | null = null;
  return (nowMs) => {
    if (!last || nowMs - last.at >= LIMITS.cacheMs || nowMs < last.at) {
      const value = fetcher(nowMs);
      last = { at: nowMs, value };
      value.catch(() => {
        if (last?.value === value) last = null;
      });
    }
    return last.value;
  };
}

export function adapterSources(): SpaceSource[] {
  const noaa = shared(fetchNoaaReadout);
  return [
    {
      id: "noaa_l1_solar_wind",
      agency: "NOAA SWPC RTSW",
      label: "OBSERVED",
      description: "1-minute L1 solar-wind plasma and magnetic field (DSCOVR/ACE/IMAP), last 3 h.",
      fields: {
        spacecraft: "L1 spacecraft",
        density_cm3: "proton density, cm^-3",
        speed_kms: "bulk speed, km/s",
        vx_gse_kms: "km/s, GSE",
        vy_gse_kms: "km/s, GSE",
        vz_gse_kms: "km/s, GSE",
        bx_gse_nt: "nT, GSE",
        by_gse_nt: "nT, GSE",
        bz_gse_nt: "nT, GSE",
        bz_gsm_nt: "nT, GSM (as published; null when absent)",
        bt_nt: "field magnitude, nT",
      },
      maxAgeMs: RTSW_MAX_AGE_MS,
      fetchRows: async (nowMs) => l1Rows(await noaa(nowMs)),
    },
    {
      id: "noaa_kp",
      agency: "NOAA SWPC",
      label: "REPORTED",
      description: "Planetary Kp index as NOAA publishes it (1-minute estimate, or the 3-hourly value).",
      fields: { kp: "Kp index, 0-9 (dimensionless)", kind: "estimated-1m | planetary-3h" },
      maxAgeMs: freshnessMs("kp_estimated_1m"),
      fetchRows: async (nowMs) => kpRows(await noaa(nowMs)),
    },
    {
      id: "goes_particles",
      agency: "NOAA SWPC GOES",
      label: "OBSERVED",
      description: "GOES integral proton (>=10 MeV) and electron (>=2 MeV) flux, newest valid sample per channel.",
      fields: { channel: "energy channel, MeV", flux_cm2_s_sr: "integral flux, cm^-2 s^-1 sr^-1", satellite: "GOES satellite" },
      maxAgeMs: PARTICLE_MAX_AGE_MS,
      fetchRows: async (nowMs) => goesRows(await fetchGoesParticles(nowMs)),
    },
    {
      id: "esa_swarm",
      agency: "ESA Swarm (VirES HAPI)",
      label: "OBSERVED",
      description: "Swarm in-situ geomagnetic field at LEO (main field, not the IMF), newest sample.",
      fields: {
        b_n_nt: "nT, local North-East-Centre (NEC)",
        b_e_nt: "nT, NEC",
        b_c_nt: "nT, NEC",
        b_total_nt: "|B|, nT",
        latitude_deg: "geocentric latitude, deg (GEO)",
        longitude_deg: "geocentric longitude, deg (GEO)",
        altitude_km: "altitude above mean Earth radius, km",
      },
      maxAgeMs: ESA_MAX_AGE_MS,
      fetchRows: async (nowMs) => swarmRows(await fetchEsaReadout(nowMs)),
    },
    {
      id: "kyoto_dst",
      agency: "WDC Kyoto",
      label: "REPORTED",
      description: "Real-time (quick-look) hourly Dst index, newest hour.",
      fields: { dst_nt: "Dst, nT" },
      maxAgeMs: DST_MAX_AGE_MS,
      fetchRows: async (nowMs) => dstRows(await fetchKyotoDst(nowMs)),
    },
  ];
}

export async function main(): Promise<void> {
  // stdout is the protocol channel: anything an adapter or library logs goes to stderr instead.
  console.log = (...args: unknown[]) => console.error(...args);
  const service = createSpaceQuery(adapterSources());
  await serveLines(service, { input: process.stdin, write: (line) => process.stdout.write(line + "\n") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("[space-query-mcp] stopped");
    process.exitCode = 1;
  });
}
