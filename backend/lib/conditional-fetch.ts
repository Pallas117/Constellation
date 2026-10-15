/**
 * JSON GET with ETag/Last-Modified revalidation. SWPC serves both validators, so a fast poll costs
 * a 304 until a product changes; the parsed body is kept so a 304 still yields data.
 */

const cache = new Map<string, { etag: string | null; lastModified: string | null; body: unknown }>();

/** Test hook: forget cached bodies and validators. */
export function resetConditionalCache(): void {
  cache.clear();
}

/** Fetch `url` as JSON; `label` names the feed in the error for a non-OK status. */
export async function fetchJsonConditional(url: string, label = url, timeoutMs = 8000): Promise<unknown> {
  const cached = cache.get(url);
  const headers: Record<string, string> = {};
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 304 && cached) {
    return cached.body;
  }
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  if (etag || lastModified) {
    cache.set(url, { etag, lastModified, body });
  }
  return body;
}
