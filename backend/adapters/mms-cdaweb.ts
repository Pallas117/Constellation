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

  const timestamp = String(fgmRow[0] ?? mecRow[0] ?? new Date().toISOString());
  const bGseRaw = Array.isArray(fgmRow[1]) ? fgmRow[1] : [0, 0, 0];
  const rGseKmRaw = Array.isArray(mecRow[1]) ? mecRow[1] : [0, 0, 0];

  const bGse = vec(Number(bGseRaw[0] ?? 0), Number(bGseRaw[1] ?? 0), Number(bGseRaw[2] ?? 0));
  const bGsm = gseToGsm(bGse, timestamp);

  // Convert position km -> Re before storing for tetrahedron geometry.
  const re = 6371;
  const rGseRe = vec(
    Number(rGseKmRaw[0] ?? 0) / re,
    Number(rGseKmRaw[1] ?? 0) / re,
    Number(rGseKmRaw[2] ?? 0) / re,
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
    const results = await Promise.all([
      fetchSpacecraft("mms1"),
      fetchSpacecraft("mms2"),
      fetchSpacecraft("mms3"),
      fetchSpacecraft("mms4"),
    ]);

    const samples = results.filter((sample): sample is MMSSpacecraftSample => Boolean(sample));
    const ts = samples.length > 0 ? samples[0].timestamp : new Date().toISOString();
    latestStatus = {
      source: SOURCE,
      lastSeen: ts,
      latencySeconds: Math.max(0, (Date.now() - Date.parse(ts)) / 1000),
      healthy: samples.length >= 3,
      message: `Fetched ${samples.length}/4 MMS spacecraft`,
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
