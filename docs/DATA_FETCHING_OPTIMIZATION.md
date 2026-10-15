# Data Fetching & Rendering Performance

This document describes how the frontend fetches live feeds from the Gauss backend and how the 3D radiation overlay keeps large datasets cheap to draw.

## Architecture Overview

The frontend talks only to the Gauss backend (`/api/...`, base URL from `apiBase()` in `lib/api/base-url.ts`). The backend fetches and caches the upstream sources (NOAA, NASA and others), so there are no per-source API clients in the browser.

Live feeds poll through one hook, `usePolledFeed` (`hooks/usePolledFeed.ts`), built on the polling loop in `lib/api/feed-poller.ts`. There is no client-side query cache: `Cybertiger.tsx` still mounts a TanStack `QueryClientProvider`, but nothing calls `useQuery`. Each hook holds its own latest data in React state.

## Polled feeds

### Polling rules (`lib/api/feed-poller.ts`)

CyberTiger counts 401/403 responses and auto-blocks the caller's IP, and the backend rate-limits with 429. The poller is built around that:

| Response | What the poller does |
|----------|----------------------|
| 2xx | Next poll after the base interval |
| 401 / 403 | Stops until the session changes; retrying can't fix it |
| 429 | Exponential backoff, honouring `Retry-After` |
| Network error, 404, 5xx | Exponential backoff |

- Backoff doubles per consecutive failure up to `maxBackoffMs` (default 5 min), with ±20% jitter so many tabs don't retry in lockstep.
- One request at a time: a `setTimeout` chain, never `setInterval`.
- Nothing is fetched while the tab is hidden; a poll that fell due while hidden runs when the tab is visible again.

### `usePolledFeed`

```tsx
const feed = usePolledFeed({
  path: session.resolved && session.signedIn ? ENDPOINT : null, // null = don't poll
  intervalMs: 5000,
  parse: parseResponse,
  disabledStatus: session.resolved ? 'sign-in-required' : 'waiting',
  restartKey: session.userKey, // a new user restarts polling
});
// feed.data, feed.status ('waiting' | 'live' | 'backing-off' | 'sign-in-required'), feed.error
```

- Requests carry the better-auth session cookie (`credentials: 'include'`). No bearer tokens, and nothing goes in the URL.
- A route the current role can't use must get `path: null`, so the UI never polls a route that would return 401/403.
- `nextPath` and `reduce` make a feed incremental: ask only for points newer than what is held, then merge them in (see `lib/api/feed-series.ts`).
- `useFeedSession()` gives `{ resolved, signedIn, userKey }` for building `path` and `restartKey`.

### Hooks that use it

| Hook | Endpoint | Interval | Signed out |
|------|----------|----------|------------|
| `useSolarWind5s` | `/api/feed/space-weather/5s` (signed in, with history) or `/api/feed/space-weather/latest` | 5 s, or 60 s for `latest` | Polls `latest` |
| `useMMSReconnection` | `/api/feed/mms/reconnection?lookback=PT2H&limit=1440` | 5 s | `sign-in-required`, not polled |
| `useAuroraMap` | `/api/feed/aurora/map?projection=gsm` | 5 s | `sign-in-required`, not polled |

`useSolarWind5s` keeps a 24 h series (at most 17,280 points), merged by timestamp. The `backfillMs` option shortens the first request for pages that only need the current drivers. With `VITE_HELIO_WS_ENABLED=true` it also listens on `/ws/feed/space-weather` (session cookie auth) and reports `source: 'websocket'` while that is open.

### Fetchers not yet on `usePolledFeed`

These still run their own `fetch` + `setInterval` loops, so they don't get the poller's backoff or its pause while the tab is hidden:

- `useSpaceWeather`: `/api/feed/space-weather/latest` every 60 s (3 min on a satellite link, not at all when air-gapped; see `useConnectivity`)
- `useAnomalyForecast`: `/api/forecast/anomaly` on its own `setInterval`
- `useMesh`: `/api/mesh/*` every 30 s (it only asks for `/devices` when the role allows it)
- `useSpaceObjects`: `/api/feed/space-objects` once on mount

## 3D Rendering Optimizations

The radiation overlay (`components/scene/RadiationDataOverlayLOD.tsx`) is described in full in [SCENE_RADIATION_VISUALIZATION.md](SCENE_RADIATION_VISUALIZATION.md). In short:

### Level-of-Detail (LOD)

| LOD | Camera distance (Earth radii) | Max Points | Point Size |
|-----|-------------------------------|------------|------------|
| 0   | ≤ 5                           | Unlimited  | 0.10       |
| 1   | 5–10                          | 50,000     | 0.08       |
| 2   | 10–15                         | 20,000     | 0.06       |
| 3   | > 15                          | 5,000      | 0.04       |

- With `lodLevel` undefined (the default from `SpaceScene`), the level follows camera distance, checked every 100 ms. Frame rate is not measured.
- Above a level's cap, points are downsampled uniformly (every n-th point).
- `<SpaceScene enableLOD={false}>` uses the plain `RadiationDataOverlay` instead, which draws every point.

### Points rendering

- All points are one `THREE.Points` object: a single draw call
- `BufferGeometry` with typed arrays for position, color and size
- Custom glow shader with additive blending
- `ShaderWarmup` compiles the overlay's shader before the first storm toggle, so turning it on doesn't stall a frame

## Client-Side Component Markers

These scene components carry a `'use client'` directive (a no-op under Vite, kept in case of a Next.js migration):

- `SpaceScene.tsx`
- `MHDWaves.tsx`
- `RadiationDataOverlay.tsx`
- `RadiationDataOverlayLOD.tsx`
- `SpaceObjectOverlay.tsx`

## Testing

Unit tests run with `npm test`:

- `lib/api/feed-poller.test.ts`: response classification, `Retry-After` parsing, backoff and jitter, and the polling loop (stops on 401, backs off on 429, never overlaps requests)
- `lib/api/feed-series.test.ts`: incremental lookback, series merging and trimming, minute buckets
- `lib/api/base-url.test.ts`: API base URL resolution

## Future Enhancements

- [ ] Move `useSpaceWeather`, `useAnomalyForecast` and `useMesh` onto `usePolledFeed`
- [ ] Remove the unused `QueryClientProvider`, or start using it
- [ ] Service Worker for offline caching
