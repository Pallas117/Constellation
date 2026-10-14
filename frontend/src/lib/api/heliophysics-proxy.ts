import type {
  AuroraMapResponse,
  CanonicalSpaceWeatherPoint,
  MMSReconVectorPoint,
  SourceStatus,
} from "@/lib/types/space-weather";
import { getAuthHeaders } from "@/lib/api/auth";
import { apiBase } from "./base-url";
import { HttpFailure } from "./http-error";

const BASE_URL = apiBase();

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
    throw new HttpFailure("Couldn't load the space weather feed", response.status);
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
    throw new HttpFailure("Couldn't load the MMS reconnection feed", response.status);
  }
  const json = (await response.json()) as { vectors?: MMSReconVectorPoint[] };
  return Array.isArray(json.vectors) ? json.vectors : [];
}

export async function fetchAuroraMap(): Promise<AuroraMapResponse> {
  const response = await fetch(`${BASE_URL}/api/feed/aurora/map?projection=gsm`, {
    headers: await getAuthHeaders(),
  });
  if (!response.ok) {
    throw new HttpFailure("Couldn't load the aurora map", response.status);
  }
  return response.json() as Promise<AuroraMapResponse>;
}

export async function fetchSourceStatus(): Promise<SourceStatus[]> {
  const response = await fetch(`${BASE_URL}/api/feed/sources/status`, {
    headers: await getAuthHeaders(),
  });
  if (!response.ok) {
    throw new HttpFailure("Couldn't load the source status", response.status);
  }
  const json = (await response.json()) as { sources?: SourceStatus[] };
  return Array.isArray(json.sources) ? json.sources : [];
}
