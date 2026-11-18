/**
 * Build a replay archive from NASA CCMC iSWA (HAPI), for a named storm (GAU-138) or a customer's
 * own window (GAU-59). Network access is injected, so tests use a recorded fixture.
 *
 * Source and terms: SWPC real-time products (US Government work, public domain) as archived by
 * NASA CCMC iSWA, served through the HAPI interface at https://iswa.gsfc.nasa.gov/IswaSystemWebApp/hapi.
 * Open data, no credentials. NOAA SWPC and NASA CCMC are to be acknowledged when results are
 * published (see TERMS). iSWA publishes no numeric rate limit that we could verify (UNVERIFIED),
 * so requests run one at a time with a pause, and 429/5xx/network errors back off exponentially.
 * Kyoto Dst is not fetched: its redistribution terms are unchecked and this repository is public.
 */
import type { ReplayArchive } from "./archive.js";
import { WARMUP_HOURS } from "./events.js";

export const ISWA = "https://iswa.gsfc.nasa.gov/IswaSystemWebApp/hapi/data";
export const TERMS =
  "NOAA SWPC real-time products (US Government work, public domain) as archived by NASA CCMC iSWA. " +
  "Acknowledge NOAA SWPC and the NASA Community Coordinated Modeling Center when publishing results.";

/** HAPI dataset ids read, recorded in every archive's `sources`. */
export const DATASETS = ["swpc_rtsw_mag_P1M", "swpc_rtsw_plasma_P1M", "goesp_part_flux_P5M", "goesp_xray_flux_P1M", "NOAA_KP_P3H"] as const;

/** One archive covers at most this many days of replay window; longer periods are split. */
export const MAX_WINDOW_DAYS = 31;
const DAY_MS = 86_400_000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Attempts per request (default 5) and the first back-off in ms (default 2000, doubling, capped at 60 s). */
  attempts?: number;
  backoffMs?: number;
  /** Pause between requests in ms (default 500). */
  pauseMs?: number;
}

export interface WindowSpec {
  id: string;
  title: string;
  /** Replay window (UTC ISO); inputs are fetched from `start` − WARMUP_HOURS. */
  start: string;
  end: string;
}

export function validateSlug(id: string): string {
  if (!SLUG.test(id)) throw new Error(`invalid archive id "${id}": use 1 to 63 characters from a-z, 0-9 and -, starting with a letter or digit`);
  return id;
}

/** Strict ISO 8601 instant with an explicit zone (a bare local time is ambiguous), as UTC ISO. */
export function parseInstant(text: string, label: string): string {
  const ms = ISO.test(text) ? Date.parse(text) : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error(`${label}: "${text}" is not an ISO 8601 time with a zone, e.g. 2026-01-19T00:00:00Z`);
  return new Date(ms).toISOString();
}

/** Validate a replay window: from < to, not in the future. Returns UTC ISO strings. */
export function validateWindow(from: string, to: string, nowMs = Date.now()): { from: string; to: string } {
  const [a, b] = [parseInstant(from, "from"), parseInstant(to, "to")];
  if (Date.parse(a) >= Date.parse(b)) throw new Error(`the window must end after it starts (${a} to ${b})`);
  if (Date.parse(b) > nowMs) throw new Error(`the window ends in the future (${b}); the archive only holds what has been published`);
  return { from: a, to: b };
}

/** Consecutive pieces of at most MAX_WINDOW_DAYS that share their boundaries and cover [from, to] exactly. */
export function splitWindow(from: string, to: string): { start: string; end: string }[] {
  const [a, b] = [Date.parse(from), Date.parse(to)];
  const out: { start: string; end: string }[] = [];
  for (let s = a; s < b; s += MAX_WINDOW_DAYS * DAY_MS) {
    out.push({ start: new Date(s).toISOString(), end: new Date(Math.min(s + MAX_WINDOW_DAYS * DAY_MS, b)).toISOString() });
  }
  return out;
}

/** Archive ids for the pieces: the slug itself for one piece, `<slug>-p1`, `-p2` … for several. */
export function pieceIds(slug: string, count: number): string[] {
  validateSlug(slug);
  return count === 1 ? [slug] : Array.from({ length: count }, (_, i) => `${slug}-p${i + 1}`);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** HAPI CSV rows (parameters must be listed in the dataset's own order). Retries 429, 5xx and network errors. */
async function hapi(id: string, parameters: string[], from: string, to: string, o: FetchOptions): Promise<string[][]> {
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const attempts = o.attempts ?? 5;
  const url = `${ISWA}?id=${id}&time.min=${from}&time.max=${to}&parameters=${parameters.join(",")}&format=csv`;
  for (let n = 1; ; n++) {
    let wait = Math.min((o.backoffMs ?? 2000) * 2 ** (n - 1), 60_000);
    try {
      const response = await doFetch(url, { signal: AbortSignal.timeout(120_000) });
      if (response.ok) {
        const text = await response.text();
        return text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /^\d{4}-/.test(line))
          .map((line) => line.split(","));
      }
      if (response.status !== 429 && response.status < 500) throw new Error(`${id}: HTTP ${response.status}`); // not retryable
      const retryAfterS = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfterS) && retryAfterS > 0) wait = Math.min(retryAfterS * 1000, 60_000);
      if (n >= attempts) throw new Error(`${id}: HTTP ${response.status} after ${n} attempts`);
    } catch (error) {
      if (error instanceof Error && /^\S+: HTTP \d+/.test(error.message)) throw error;
      // No URL or cause text in the message (it is logged); the cause travels with the error for a debugger.
      if (n >= attempts) throw new Error(`${id}: request failed after ${n} attempts`, { cause: error });
    }
    await sleep(wait);
  }
}

const num = (v: string | undefined) => (v === undefined || v === "" ? Number.NaN : Number(v));
const iso = (t: string) => {
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) throw new Error("upstream sent a row with an unreadable time");
  return new Date(ms).toISOString();
};
const sorted = <T extends [string, ...unknown[]]>(rows: T[]) => rows.sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));

/**
 * The archive for `spec`. Upstream is untrusted: rows with unreadable times are an error, rows
 * outside the requested range are dropped, and an archive with no L1 data at all is refused.
 */
export async function fetchArchive(spec: WindowSpec, o: FetchOptions = {}): Promise<ReplayArchive> {
  const from = new Date(Date.parse(spec.start) - WARMUP_HOURS * 3_600_000).toISOString();
  const to = spec.end;
  const [fromMs, toMs] = [Date.parse(from), Date.parse(to)];
  const sleep = o.sleep ?? defaultSleep;
  const get = async (id: string, parameters: string[], a = from) => {
    const rows = await hapi(id, parameters, a, to, o);
    await sleep(o.pauseMs ?? 500);
    return rows;
  };
  // One request at a time, to stay inside iSWA's limits.
  const mag = await get("swpc_rtsw_mag_P1M", ["B_x", "B_y", "B_z", "B_t", "isPrimary", "source"]);
  const plasma = await get("swpc_rtsw_plasma_P1M", ["ProtonDensity", "BulkSpeed", "IonTemperature", "isPrimary", "source"]);
  const protons = await get("goesp_part_flux_P5M", ["P10", "P50", "P100", "satelliteProton"]);
  const electrons = await get("goesp_part_flux_P5M", ["E2_0", "satelliteElectron"]);
  const xrays = await get("goesp_xray_flux_P1M", ["Short_Wave", "Long_Wave", "satellite"]);
  // Kp intervals that end inside the window; the replay serves each only once it has ended.
  const kp = await get("NOAA_KP_P3H", ["Kp_observed", "StartTime", "EndTime"], new Date(fromMs - 6 * 3_600_000).toISOString());
  const within = <T extends string[]>(rows: T[]) => rows.filter((r) => Date.parse(r[0]) <= toMs && Date.parse(r[0]) >= fromMs - 6 * 3_600_000);
  const [magIn, plasmaIn] = [within(mag), within(plasma)];
  if (magIn.length === 0 && plasmaIn.length === 0) throw new Error(`no L1 data returned for ${from} to ${to}`);
  return {
    id: spec.id,
    title: spec.title,
    start: spec.start,
    end: spec.end,
    fetchedAt: new Date((o.now ?? Date.now)()).toISOString(),
    sources: [{ dataset: DATASETS.join(", "), url: ISWA }],
    terms: TERMS,
    // Only the operational spacecraft (isPrimary = 1), as the live pipeline uses it.
    mag: sorted(magIn.filter((r) => r[5] === "1").map((r) => [iso(r[0]), num(r[1]), num(r[2]), num(r[3]), num(r[4]), r[6]])),
    // Temperature last, so the older rows' positions still hold (GAU-139 part B needs T/T_exp).
    plasma: sorted(plasmaIn.filter((r) => r[4] === "1").map((r) => [iso(r[0]), num(r[1]), num(r[2]), r[5], num(r[3])])),
    protons: sorted(within(protons).map((r) => [iso(r[0]), num(r[1]), num(r[2]), num(r[3]), r[4]])),
    electrons: sorted(within(electrons).map((r) => [iso(r[0]), num(r[1]), r[2]])),
    xrays: sorted(within(xrays).map((r) => [iso(r[0]), num(r[2]), num(r[1]), r[3]])),
    kp: sorted(
      kp
        .filter((r) => Number.isFinite(num(r[1])) && num(r[1]) >= 0)
        .map((r) => [iso(r[2]), iso(r[3]), num(r[1])] as [string, string, number]),
    ),
  };
}
