import { gseToGsm, vec } from "../physics/coordinates.js";
import type { DataSource, SourceStatus } from "../types.js";
import type { MMSSpacecraftSample } from "../physics/reconnection.js";

const SOURCE: DataSource = "mms-cdaweb";

let latestStatus: SourceStatus = {
  source: SOURCE,
  lastSeen: null,
  latencySeconds: null,
  healthy: false,
  message: "Not fetched yet",
};

function toIso(ts: Date): string {
  return ts.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function fetchHapi(id: string, parameters: string, start: string, stop: string): Promise<any> {
  const url = new URL("https://cdaweb.gsfc.nasa.gov/hapi/data");
  url.searchParams.set("id", id);
  url.searchParams.set("parameters", parameters);
  url.searchParams.set("time.min", start);
  url.searchParams.set("time.max", stop);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(9000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`CDAWeb HAPI ${id} returned HTTP ${response.status}`);
  }
  return response.json();
}

// CDF/HAPI fill values are large negative sentinels (e.g. -1e31).
const FILL_THRESHOLD = 1e30;

function finiteTriple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out = value.slice(0, 3).map((v) => (v === null || v === "" ? Number.NaN : Number(v)));
  return out.every((v) => Number.isFinite(v) && Math.abs(v) < FILL_THRESHOLD)
    ? (out as [number, number, number])
    : null;
}

async function fetchSpacecraft(id: "mms1" | "mms2" | "mms3" | "mms4"): Promise<MMSSpacecraftSample | null> {
  const now = new Date();
  const start = new Date(now.getTime() - 10 * 60 * 1000);
  const sc = id.toUpperCase();

  // Survey-level stream names are standardized in CDAWeb catalogs.
  const fgmId = `${sc}_FGM_SRVY_L2`;
  const mecId = `${sc}_MEC_SRVY_L2_EPHT89D`;

  const [fgm, mec] = await Promise.all([
    fetchHapi(fgmId, "Epoch,B_GSE", toIso(start), toIso(now)),
    fetchHapi(mecId, "Epoch,XYZ_GSE", toIso(start), toIso(now)),
  ]);

  const fgmRow = Array.isArray(fgm?.data) && fgm.data.length > 0 ? fgm.data[fgm.data.length - 1] : null;
  const mecRow = Array.isArray(mec?.data) && mec.data.length > 0 ? mec.data[mec.data.length - 1] : null;
  if (!Array.isArray(fgmRow) || !Array.isArray(mecRow)) {
    return null;
  }

  const timestamp = typeof fgmRow[0] === "string" ? fgmRow[0] : null;
  const bGseRaw = finiteTriple(fgmRow[1]);
  const rGseKmRaw = finiteTriple(mecRow[1]);
  if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || !bGseRaw || !rGseKmRaw) {
    // Missing or fill-valued components are not data; never substitute zeros.
    return null;
  }

  const bGse = vec(bGseRaw[0], bGseRaw[1], bGseRaw[2]);
  const bGsm = gseToGsm(bGse, timestamp);

  // Convert position km -> Re before storing for tetrahedron geometry.
  const re = 6371;
  const rGseRe = vec(
    rGseKmRaw[0] / re,
    rGseKmRaw[1] / re,
    rGseKmRaw[2] / re,
  );
  const rGsmRe = gseToGsm(rGseRe, timestamp);

  return {
    id,
    timestamp,
    positionGsmRe: rGsmRe,
    magneticFieldNt: bGsm,
  };
}

export async function fetchMmsCdawebSamples(): Promise<MMSSpacecraftSample[]> {
  try {
    // One spacecraft failing must not discard the other three.
    const results = await Promise.allSettled(
      (["mms1", "mms2", "mms3", "mms4"] as const).map((id) => fetchSpacecraft(id)),
    );

    const samples: MMSSpacecraftSample[] = [];
    const failures: string[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value) samples.push(result.value);
      } else {
        failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    }

    // lastSeen only advances when data actually arrived; it is the newest sample time.
    const newest = samples.reduce<string | null>(
      (latest, sample) => (latest === null || Date.parse(sample.timestamp) > Date.parse(latest) ? sample.timestamp : latest),
      null,
    );
    const lastSeen = newest ?? latestStatus.lastSeen;
    const failureNote = failures.length > 0 ? `; ${failures.length} failed: ${failures[0]}` : "";
    latestStatus = {
      source: SOURCE,
      lastSeen,
      latencySeconds: lastSeen ? Math.max(0, (Date.now() - Date.parse(lastSeen)) / 1000) : null,
      healthy: samples.length >= 3,
      message: `Fetched ${samples.length}/4 MMS spacecraft${failureNote}`,
    };

    return samples;
  } catch (error) {
    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.lastSeen
        ? Math.max(0, (Date.now() - Date.parse(latestStatus.lastSeen)) / 1000)
        : null,
      healthy: false,
      message: error instanceof Error ? error.message : "MMS CDAWeb fetch failed",
    };
    return [];
  }
}

export function getMmsCdawebStatus(): SourceStatus {
  return latestStatus;
}
