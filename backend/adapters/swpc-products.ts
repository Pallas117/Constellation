/**
 * NOAA SWPC's own space-weather scales and alerts, read as a cross-check on the levels Gauss
 * derives itself (GAU-136). They are never the source of record: if this feed fails, the
 * cross-check reads unknown and everything else carries on.
 */
import type { NoaaScales } from "../lib/sense-checks.js";
import type { NoaaAlert } from "../types.js";
import { fetchSwpcJson, SWPC_ORIGIN } from "./swpc-fetch.js";

const SCALES_URL = `${SWPC_ORIGIN}/products/noaa-scales.json`;
const ALERTS_URL = `${SWPC_ORIGIN}/products/alerts.json`;

export interface SwpcProducts {
  scales: NoaaScales | null;
  /** Null when the alerts product couldn't be read: unknown, not "no alerts". */
  alerts: NoaaAlert[] | null;
}

type Rec = Record<string, unknown>;

/** "2026-10-19" + "08:45:00" (UTC, no zone) → ISO; null when unparseable. */
const stamp = (date: unknown, time: unknown): string | null => {
  if (typeof date !== "string" || typeof time !== "string") return null;
  const ms = Date.parse(`${date.trim()}T${time.trim()}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const level = (entry: unknown): number | null => {
  const raw = entry && typeof entry === "object" ? (entry as Rec).Scale : null;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
};

/** Entry "0" of noaa-scales.json is NOAA's latest observed R/S/G; "-1" is the previous day, "1"-"3" forecasts. */
export function parseNoaaScales(data: unknown): NoaaScales | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const now = (data as Rec)["0"];
  if (!now || typeof now !== "object") return null;
  const rec = now as Rec;
  return { R: level(rec.R), S: level(rec.S), G: level(rec.G), observedAt: stamp(rec.DateStamp, rec.TimeStamp) };
}

const HEADLINE = /^(ALERT|WARNING|EXTENDED WARNING|WATCH|SUMMARY|CANCEL[A-Z ]*):\s*(.+)$/m;

/**
 * NOAA alerts issued in the last `windowMs`, newest first, one per product code (a newer
 * issue of the same product supersedes the older one), at most `max`.
 */
export function parseNoaaAlerts(data: unknown, nowMs: number, windowMs = 24 * 3_600_000, max = 5): NoaaAlert[] {
  if (!Array.isArray(data)) return [];
  const latest = new Map<string, NoaaAlert>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Rec;
    const productId = typeof rec.product_id === "string" ? rec.product_id.trim() : "";
    const issued = typeof rec.issue_datetime === "string" ? Date.parse(`${rec.issue_datetime.trim().replace(" ", "T")}Z`) : Number.NaN;
    const match = typeof rec.message === "string" ? HEADLINE.exec(rec.message) : null;
    if (!productId || !Number.isFinite(issued) || !match) continue;
    if (issued > nowMs || nowMs - issued > windowMs) continue;
    const prev = latest.get(productId);
    if (prev && Date.parse(prev.issuedAt) >= issued) continue;
    const headline = `${match[1]}: ${match[2].trim()}`.slice(0, 160);
    latest.set(productId, { productId, issuedAt: new Date(issued).toISOString(), headline });
  }
  return [...latest.values()].sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt)).slice(0, max);
}

/** Both products; either can fail alone. Null only when both did. */
export async function fetchSwpcProducts(nowMs = Date.now()): Promise<SwpcProducts | null> {
  const [scales, alerts] = await Promise.all([
    fetchSwpcJson(SCALES_URL).then(parseNoaaScales, () => undefined),
    fetchSwpcJson(ALERTS_URL).then((d) => parseNoaaAlerts(d, nowMs), () => undefined),
  ]);
  if (scales === undefined && alerts === undefined) return null;
  return { scales: scales ?? null, alerts: alerts ?? null };
}
