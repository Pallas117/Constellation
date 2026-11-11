# Space Weather Monitor - System Architecture

## Overview

A lightweight, real-time 3D visualization of Earth's magnetosphere and Van Allen radiation belts, driven by live space weather data from NOAA SWPC and NASA DSCOVR.

---

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL DATA SOURCES                              │
├─────────────────┬─────────────────┬─────────────────┬───────────────────────┤
│   NOAA SWPC     │  NASA DSCOVR    │   NOAA GOES     │    Fallback Cache     │
│  (Kp, alerts)   │ (solar wind)    │ (particle flux) │  (rolling average)    │
└────────┬────────┴────────┬────────┴────────┬────────┴───────────┬───────────┘
         │                 │                 │                    │
         └─────────────────┴─────────────────┴────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              EXPRESS BACKEND (backend/server.ts, port 3001)                 │
│                                                                             │
│  IngestionWorker (backend/worker/ingest-loop.ts, 5 s tick)                  │
│    NOAA, Kyoto Dst, GOES, SWPC products, ESA, JAXA, MMS, LASP adapters      │
│                              │                                              │
│                              ▼                                              │
│  In-memory canonical feed (backend/state.ts)                                │
│    + bedrock local store fallback (backend/lib/local-db.ts)                 │
│                              │                                              │
│                              ▼                                              │
│  GET /api/feed/space-weather/latest  (public in API_POLICY, backend/rbac.ts)│
│    → CanonicalSpaceWeatherPoint + freshness; 404 until the first point      │
└─────────────────────────────────────────────────────────────┬───────────────┘
                                                              │
                                                              │ HTTPS + CORS
                                                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            FRONTEND APPLICATION                              │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         DATA STATE MANAGER                             │  │
│  │  ┌─────────────┐  ┌─────────────────┐  ┌────────────────────────────┐ │  │
│  │  │   Fetcher   │→ │  Interpolation  │→ │   Derived Parameters       │ │  │
│  │  │  (1-2 min)  │  │  Engine (EMA)   │  │  (compression, intensity)  │ │  │
│  │  └─────────────┘  └─────────────────┘  └────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                              │                                               │
│          ┌───────────────────┼───────────────────┐                          │
│          ▼                   ▼                   ▼                          │
│  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐                  │
│  │  3D Renderer  │   │    UI Layer   │   │  Performance  │                  │
│  │  (Three.js)   │   │    (React)    │   │   Monitor     │                  │
│  └───────────────┘   └───────────────┘   └───────────────┘                  │
│          │                                                                   │
│          ▼                                                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        SHADER MODULES                                  │  │
│  │  ┌──────────┐  ┌────────────────┐  ┌──────────────┐  ┌─────────────┐  │  │
│  │  │  Earth   │  │  Van Allen     │  │ Magnetosphere│  │ Field Lines │  │  │
│  │  │  Shader  │  │  Belts (SDF)   │  │   (Shue)     │  │ (Instanced) │  │  │
│  │  └──────────┘  └────────────────┘  └──────────────┘  └─────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Breakdown

### Backend (Express)

| Component | Responsibility |
|-----------|----------------|
| `backend/server.ts` | Express app, routes (`GET /api/feed/space-weather/latest` and siblings), WebSocket feed |
| `backend/rbac.ts` | `API_POLICY` allowlist: unlisted routes 404, no session 401, wrong role 403 |
| `backend/worker/ingest-loop.ts` | `IngestionWorker`: polls the source adapters on a 5 s tick, builds canonical points |
| `backend/state.ts` | In-memory canonical feed (`getLatestCanonical`) |
| `backend/lib/local-db.ts` | Bedrock local store, fallback when memory is empty |

### Frontend

| Component | Responsibility |
|-----------|----------------|
| `useSpaceWeather` | Data fetching, interpolation, derived params |
| `SpaceScene` | Three.js canvas setup, camera, lighting |
| `Earth` | Earth mesh with atmosphere shader |
| `VanAllenBelts` | Instanced particles with SDF glow |
| `Magnetosphere` | Parametric Shue model surface |
| `HUD` | Live data display with stale indicators |
| `LayerToggles` | Visibility controls for each layer |

---

## Data Models

### Backend Output Schema

```typescript
interface SpaceWeatherResponse {
  timestamp: string;          // ISO 8601
  solarWind: {
    speed: number;            // km/s
    density: number;          // particles/cm³
    pressure: number;         // nPa
  };
  imf: {
    bz: number;               // nT (negative = southward)
    bt: number;               // nT total
  };
  particles: {
    protonFlux: number;       // pfu (>10 MeV)
    electronFlux: number;     // electrons/cm²/s/sr
  };
  indices: {
    kp: number;               // 0-9
    dst: number;              // nT
  };
  flags: {
    stale: boolean;
    source: 'live' | 'cache' | 'fallback';
    lastUpdate: string;
  };
}
```

### Frontend Derived State

```typescript
interface VisualizationState {
  magnetopauseCompression: number;  // 0.6-1.0 (1 = relaxed)
  beltIntensity: number;            // 0-1
  reconnectionStrength: number;     // 0-1 (southward Bz)
  stormLevel: number;               // 0-1 (Kp normalized)
}
```

---

## Sequence Diagram: Data Refresh Cycle

```
┌──────────┐     ┌──────────────┐     ┌────────────────┐     ┌─────────────┐
│ Frontend │     │ Express API  │     │IngestionWorker │     │ Source APIs │
└────┬─────┘     └──────┬───────┘     └───────┬────────┘     └──────┬──────┘
     │                  │                     │  every 5 s tick     │
     │                  │                     │  (per-source rate)  │
     │                  │                     │────────────────────>│
     │                  │                     │<────────────────────│
     │                  │  canonical point    │                     │
     │                  │  to memory feed     │                     │
     │                  │<────────────────────│                     │
     │                  │                     │                     │
     │  GET /api/feed/space-weather/latest    │                     │
     │─────────────────>│                     │                     │
     │                  │  latest from memory │                     │
     │                  │  (bedrock fallback) │                     │
     │<─────────────────│                     │                     │
     │  JSON (point + freshness), or 404      │                     │
     │                  │                     │                     │
     │  Start Interpolation                   │                     │
     │  (8-12 sec EMA)  │                     │                     │
     │                  │                     │                     │
     │  Update 3D Scene │                     │                     │
     │  (60fps render)  │                     │                     │
     │                  │                     │                     │
```

---

## Fail-Soft Pathways

### Stale Data Handling

1. **Cache Hit (fresh)**: Return cached data immediately
2. **Cache Hit (stale)**: Return stale data with `flags.stale = true`
3. **API Failure**: Return cached data or fallback values
4. **Complete Failure**: Frontend uses rolling average decay

### Frontend Decay Logic

```typescript
// When data is stale, gradually decay toward baseline
const decayFactor = Math.exp(-timeSinceUpdate / DECAY_HALF_LIFE);
const decayedValue = baseline + (lastValue - baseline) * decayFactor;
```

---

## Security Architecture

| Layer | Protection |
|-------|------------|
| Transport | HTTPS only |
| CORS | Strict origin whitelist |
| CSP | `script-src 'self'` |
| Input | Schema validation on all external data |
| Rate Limit | 60 req/min per IP |
| Secrets | Stored in Lovable Cloud secrets |

---

## Performance Targets

| Metric | Target |
|--------|--------|
| Initial Load | < 2 seconds |
| Data Refresh Size | < 200KB |
| Frame Time | < 16.67ms (60fps) |
| Shader Time | < 8ms per frame |
| Backend Cold Start | < 1.5s |

---

## File Structure

```
src/
├── components/
│   ├── scene/
│   │   ├── SpaceScene.tsx      # Main Three.js canvas
│   │   ├── Earth.tsx           # Earth mesh + atmosphere
│   │   ├── VanAllenBelts.tsx   # Radiation belts
│   │   └── Magnetosphere.tsx   # Field lines + magnetopause
│   ├── ui/
│   │   ├── HUD.tsx             # Live data display
│   │   ├── LayerToggles.tsx    # Layer visibility
│   │   └── ScreenshotButton.tsx
│   └── SpaceWeatherVisualization.tsx
├── hooks/
│   └── useSpaceWeather.ts      # Data fetching + interpolation
├── lib/
│   ├── dataProcessing.ts       # Interpolation, validation
│   └── utils.ts
└── pages/
    └── Index.tsx

docs/
├── ARCHITECTURE.md             # This file
├── SHADER_SPEC.md              # Shader design specification
└── QA_TEST_PLAN.md             # QA strategy
```
