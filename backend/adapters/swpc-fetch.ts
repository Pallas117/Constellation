/**
 * The one way the sense-check feeds reach NOAA SWPC: public HTTPS JSON products on
 * services.swpc.noaa.gov only. Anything else is refused before a request is made, so a
 * mistyped or injected URL can't send the backend to another host. GAU-136.
 */
export const SWPC_ORIGIN = "https://services.swpc.noaa.gov";

export async function fetchSwpcJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.origin !== SWPC_ORIGIN || parsed.username || parsed.password || parsed.search) {
    throw new Error(`Refused a feed outside ${SWPC_ORIGIN}`);
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`SWPC ${parsed.pathname} returned HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Like fetchSwpcJson but returns the response (status, headers) so a caller can read a byte range
 * or check the size first. Same host rule; `signal` lets several requests share one time budget.
 */
export async function fetchSwpcResponse(url: string, init: { signal: AbortSignal; headers?: Record<string, string> }): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.origin !== SWPC_ORIGIN || parsed.username || parsed.password || parsed.search) {
    throw new Error(`Refused a feed outside ${SWPC_ORIGIN}`);
  }
  const response = await fetch(parsed, { signal: init.signal, headers: init.headers });
  if (!response.ok) {
    throw new Error(`SWPC ${parsed.pathname} returned HTTP ${response.status}`);
  }
  return response;
}
