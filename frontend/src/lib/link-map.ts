// Shared signal map: one row per network, from the latest report of every device
// (backend/mesh/store.ts MeshLinkSample, sent by tools/argo/linksample.go).
// Hashes and owner-chosen place labels only: no SSIDs, no locations. Pure, so a
// test can run it without the app.

export interface LinkSampleLike {
  class: string;
  bearer: string;
  network?: string;
  place?: string;
  signalDbm?: number;
  noiseDbm?: number;
  lossPct: number;
  rttMs: number;
  low: boolean;
}

export interface DeviceWithSample {
  name: string;
  last?: { receivedAt: string; linkSample?: LinkSampleLike };
}

export type LinkQuality = "good" | "fair" | "poor";

export interface NetworkRow {
  key: string;
  label: string;
  devices: number;
  classes: string[];
  lossPct: number; // mean over devices
  rttMs: number | null; // median of measured values
  signalDbm: number | null; // best (highest) reading
  snrDb: number | null; // for that reading
  lowDevices: number;
  quality: LinkQuality;
}

export const SAMPLE_MAX_AGE_MS = 60 * 60_000;

export function qualityOf(lossPct: number, rttMs: number | null, lowDevices: number): LinkQuality {
  if (lossPct >= 15 || lowDevices > 0 || (rttMs !== null && rttMs >= 1500)) return "poor";
  if (lossPct < 5 && rttMs !== null && rttMs < 600) return "good";
  return "fair";
}

const ORDER: Record<LinkQuality, number> = { poor: 0, fair: 1, good: 2 };

export function summariseLinks(devices: DeviceWithSample[], now: number, maxAgeMs = SAMPLE_MAX_AGE_MS): NetworkRow[] {
  const groups = new Map<string, { label: string; samples: LinkSampleLike[] }>();
  for (const d of devices) {
    const s = d.last?.linkSample;
    if (!s || now - Date.parse(d.last!.receivedAt) > maxAgeMs) continue;
    const key = s.network ? `n:${s.network}` : s.place ? `p:${s.place}` : "unknown";
    const label = s.place ?? (s.network ? `network ${s.network.slice(0, 6)}` : "unknown network");
    const g = groups.get(key) ?? { label, samples: [] };
    if (s.place) g.label = s.place;
    g.samples.push(s);
    groups.set(key, g);
  }
  const rows: NetworkRow[] = [];
  for (const [key, g] of groups) {
    const rtts = g.samples.map((s) => s.rttMs).filter((v) => v >= 0).sort((a, b) => a - b);
    const rttMs = rtts.length ? rtts[Math.floor(rtts.length / 2)] : null;
    const lossPct = Math.round(g.samples.reduce((a, s) => a + s.lossPct, 0) / g.samples.length);
    const withSignal = g.samples.filter((s) => s.signalDbm !== undefined && s.noiseDbm !== undefined);
    const best = withSignal.sort((a, b) => b.signalDbm! - a.signalDbm!)[0];
    const lowDevices = g.samples.filter((s) => s.low).length;
    rows.push({
      key,
      label: g.label,
      devices: g.samples.length,
      classes: [...new Set(g.samples.map((s) => s.class))].sort(),
      lossPct,
      rttMs,
      signalDbm: best ? best.signalDbm! : null,
      snrDb: best ? best.signalDbm! - best.noiseDbm! : null,
      lowDevices,
      quality: qualityOf(lossPct, rttMs, lowDevices),
    });
  }
  return rows.sort((a, b) => ORDER[a.quality] - ORDER[b.quality] || a.label.localeCompare(b.label));
}
