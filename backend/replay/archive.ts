/**
 * A historical storm as the live pipeline would have seen it (GAU-138).
 *
 * The archive holds the SWPC real-time products that the live adapters read, as archived by
 * NASA CCMC iSWA (US Government data, public domain). `archiveFetch` answers the live adapters' own
 * requests (same URLs, same JSON shapes) at a replay clock, so the replay runs the unchanged
 * ingest → sense-check → nowcast code. A row is served only once it would have been published
 * (its averaging interval has ended), so nothing from the future leaks in.
 *
 * Gaps against live, all of which read "unknown" rather than being faked:
 * - iSWA keeps only the operational L1 spacecraft, so the density cross-check has no reference;
 * - no running 1-minute Kp estimate is archived, so Kp comes from completed 3-hour intervals
 *   only and the G level lags live by up to 3 h;
 * - NOAA's own scales and alerts are not archived, so that cross-check is unknown;
 * - GOES electron contamination is not archived; ovation aurora is not served;
 * - Kyoto Dst is left out (its redistribution terms are unchecked and this repository is
 *   public), so Dst is the nowcast's labelled model estimate, as live when Kyoto is stale.
 */
import { gsmToGse, vec } from "../physics/coordinates.js";
import type { L1Sample } from "../physics/l1-structures.js";

/** [time, Bx, By, Bz (GSM, nT), Bt, spacecraft]; RTSW fill -999.9 kept as received. */
export type MagRow = [string, number, number, number, number, string];
/** [time, density cm^-3, speed km/s, spacecraft]; fill -9999. */
export type PlasmaRow = [string, number, number, string];
/** [time, >=10, >=50, >=100 MeV protons (pfu), satellite]; GOES fill -1e5. */
export type ProtonRow = [string, number, number, number, string];
/** [time, >=2 MeV electrons, satellite]. */
export type ElectronRow = [string, number, string];
/** [time, 0.1-0.8 nm, 0.05-0.4 nm (W m^-2), satellite]; 0 is a fill. */
export type XrayRow = [string, number, number, string];
/** [interval start, interval end, Kp]. */
export type KpRow = [string, string, number];

export interface ArchiveSource {
  dataset: string;
  url: string;
}

export interface ReplayArchive {
  id: string;
  title: string;
  /** Replay window (UTC). Inputs start earlier so L1 history, GOES files and Kp are warm. */
  start: string;
  end: string;
  fetchedAt: string;
  /** Where every stream came from, and its terms. */
  sources: ArchiveSource[];
  terms: string;
  mag: MagRow[];
  plasma: PlasmaRow[];
  protons: ProtonRow[];
  electrons: ElectronRow[];
  xrays: XrayRow[];
  kp: KpRow[];
}

const MIN = 60_000;
/** Each live file's span: RTSW keeps 24 h (4 h is enough for the 3 h series), GOES 6 h. */
const RTSW_SPAN_MS = 4 * 60 * MIN;
const GOES_SPAN_MS = 6 * 60 * MIN;

const ms = (iso: string) => Date.parse(iso);
/** RTSW and Kp time_tags carry no zone, as SWPC publishes them. */
const swpcTag = (iso: string) => new Date(ms(iso)).toISOString().slice(0, 19);
const fill = (v: number, f: number) => (v === f || !Number.isFinite(v) ? null : v);
const satNumber = (s: string) => {
  const n = Number(/(\d+)/.exec(s)?.[1]);
  return Number.isFinite(n) ? n : null;
};

/**
 * Rows of a time-sorted stream published by `nowMs`: measured in (nowMs − spanMs, nowMs − cadence],
 * i.e. only intervals that had ended. Binary search, since the replay asks every minute.
 */
export function publishedRows<T extends [string, ...unknown[]]>(rows: T[], nowMs: number, spanMs: number, cadenceMs: number): T[] {
  const lo = nowMs - spanMs;
  const hi = nowMs - cadenceMs;
  const first = lowerBound(rows, (t) => t > lo);
  const last = lowerBound(rows, (t) => t > hi);
  return rows.slice(first, last);
}

function lowerBound<T extends [string, ...unknown[]]>(rows: T[], after: (t: number) => boolean): number {
  let a = 0;
  let b = rows.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (after(ms(rows[m][0]))) b = m;
    else a = m + 1;
  }
  return a;
}

/** The body the live adapter would have received for `pathname` at `nowMs`, or undefined (404). */
export function archiveBody(archive: ReplayArchive, pathname: string, nowMs: number): unknown {
  switch (pathname) {
    case "/json/rtsw/rtsw_mag_1m.json":
      return publishedRows(archive.mag, nowMs, RTSW_SPAN_MS, MIN)
        .reverse() // newest first, as SWPC serves it
        .map(([t, bx, by, bz, bt, source]) => {
          const gsm = [fill(bx, -999.9), fill(by, -999.9), fill(bz, -999.9)];
          const ok = gsm.every((v) => v !== null);
          const gse = ok ? gsmToGse(vec(gsm[0]!, gsm[1]!, gsm[2]!), t) : null;
          return {
            time_tag: swpcTag(t),
            active: true,
            source,
            bt: fill(bt, -999.9),
            bx_gse: gse?.x ?? null,
            by_gse: gse?.y ?? null,
            bz_gse: gse?.z ?? null,
            bx_gsm: gsm[0],
            by_gsm: gsm[1],
            bz_gsm: gsm[2],
          };
        });
    case "/json/rtsw/rtsw_wind_1m.json":
      return publishedRows(archive.plasma, nowMs, RTSW_SPAN_MS, MIN)
        .reverse()
        .map(([t, density, speed, source]) => ({
          time_tag: swpcTag(t),
          active: true,
          source,
          proton_density: fill(density, -9999),
          proton_speed: fill(speed, -9999),
        }));
    case "/json/planetary_k_index_1m.json":
      return []; // not archived: Kp comes from completed intervals only
    case "/products/noaa-planetary-k-index.json":
      return archive.kp
        .filter(([, end, kp]) => ms(end) <= nowMs && kp >= 0)
        .map(([start, , kp]) => ({ time_tag: swpcTag(start), Kp: kp }));
    case "/json/goes/primary/integral-protons-6-hour.json":
      return publishedRows(archive.protons, nowMs, GOES_SPAN_MS, 5 * MIN).flatMap(([t, p10, p50, p100, sat]) =>
        ([[">=10 MeV", p10], [">=50 MeV", p50], [">=100 MeV", p100]] as const).map(([energy, flux]) => ({
          time_tag: t,
          satellite: satNumber(sat),
          flux,
          energy,
        })),
      );
    case "/json/goes/primary/integral-electrons-6-hour.json":
      return publishedRows(archive.electrons, nowMs, GOES_SPAN_MS, 5 * MIN).map(([t, flux, sat]) => ({
        time_tag: t,
        satellite: satNumber(sat),
        flux,
        energy: ">=2 MeV",
      }));
    case "/json/goes/primary/xrays-6-hour.json":
      return publishedRows(archive.xrays, nowMs, GOES_SPAN_MS, MIN).flatMap(([t, long, short, sat]) => [
        { time_tag: t, satellite: satNumber(sat), flux: short, energy: "0.05-0.4nm" },
        { time_tag: t, satellite: satNumber(sat), flux: long, energy: "0.1-0.8nm" },
      ]);
    default:
      return undefined;
  }
}

/** A fetch that answers from the archive at the clock's time; anything not archived is a 404. */
export function archiveFetch(archive: ReplayArchive, now: () => number): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = archiveBody(archive, url.pathname, now());
    return body === undefined
      ? new Response(JSON.stringify({ error: "not archived" }), { status: 404 })
      : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/**
 * The archive's L1 minutes as structure-detection input (GAU-139). Fills and non-physical values
 * (RTSW -999.9 / -9999, zero or negative density, speed or field magnitude) read as missing.
 */
export function archiveL1Samples(archive: ReplayArchive): L1Sample[] {
  const positive = (x: number | undefined) => (x !== undefined && Number.isFinite(x) && x > 0 ? x : null);
  const mag = new Map(archive.mag.map((row) => [row[0], row]));
  const plasma = new Map(archive.plasma.map((row) => [row[0], row]));
  return [...new Set([...mag.keys(), ...plasma.keys()])].sort().map((time) => {
    const bz = mag.get(time)?.[3];
    return {
      time,
      bzGsmNt: bz !== undefined && Number.isFinite(bz) && bz > -999 ? bz : null,
      btNt: positive(mag.get(time)?.[4]),
      densityCm3: positive(plasma.get(time)?.[1]),
      speedKmS: positive(plasma.get(time)?.[2]),
    };
  });
}
