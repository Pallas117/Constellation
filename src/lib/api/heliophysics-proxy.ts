import type {
  AuroraMapResponse,
  CanonicalSpaceWeatherPoint,
  MMSReconVectorPoint,
  SourceStatus,
} from "@/lib/types/space-weather";
import { getAuthHeaders } from "@/lib/api/auth";

const BASE_URL = import.meta.env.VITE_HELIO_PROXY_URL ?? "http://localhost:3001";

export async function fetchSpaceWeather5s(
  lookback = "PT24H",
  limit = 17280,
): Promise<CanonicalSpaceWeatherPoint[]> {
  const response = await fetch(
    `${BASE_URL}/api/feed/space-weather/5s?lookback=${encodeURIComponent(lookback)}&limit=${limit}`,
    {
      headers: await getAuthHeaders(),
    },
  );
  if (!response.ok) {
    throw new Error(`Space weather feed HTTP ${response.status}`);
  }
  const json = (await response.json()) as { points?: CanonicalSpaceWeatherPoint[] };
  return Array.isArray(json.points) ? json.points : [];
}

export async function fetchMmsReconnection(
  lookback = "PT2H",
  limit = 1440,
): Promise<MMSReconVectorPoint[]> {
  const response = await fetch(
    `${BASE_URL}/api/feed/mms/reconnection?lookback=${encodeURIComponent(lookback)}&limit=${limit}`,
    {
      headers: await getAuthHeaders(),
    },
  );
  if (!response.ok) {
    throw new Error(`MMS reconnection feed HTTP ${response.status}`);
  }
  const json = (await response.json()) as { vectors?: MMSReconVectorPoint[] };
  return Array.isArray(json.vectors) ? json.vectors : [];
}

export async function fetchAuroraMap(): Promise<AuroraMapResponse> {
  const response = await fetch(`${BASE_URL}/api/feed/aurora/map?projection=gsm`, {
    headers: await getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Aurora map HTTP ${response.status}`);
  }
  return response.json() as Promise<AuroraMapResponse>;
}

export async function fetchSourceStatus(): Promise<SourceStatus[]> {
  const response = await fetch(`${BASE_URL}/api/feed/sources/status`, {
    headers: await getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Source status HTTP ${response.status}`);
  }
  const json = (await response.json()) as { sources?: SourceStatus[] };
  return Array.isArray(json.sources) ? json.sources : [];
}
