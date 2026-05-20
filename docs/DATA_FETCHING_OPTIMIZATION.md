# Data Fetching Optimization & Caching Strategy

This document describes the comprehensive caching strategy and data fetching optimizations implemented for the space radiation web app.

## Architecture Overview

The app uses a **service-based architecture** with typed clients for each data source, combined with **React Query (TanStack Query)** for intelligent caching and revalidation.

## Service Clients

### Directory Structure

```
src/services/
├── nasa-client.ts    # NASA OMNI API client
├── erg-client.ts     # ERG/Arase CSV client
├── cses-client.ts    # CSES CSV client
└── index.ts          # Central exports
```

### NASA OMNI Client (`nasa-client.ts`)

**Features:**
- Typed query options for React Query
- Automatic cache strategy based on data age:
  - **Static data** (>7 days old): 1 hour stale time, 24 hour cache
  - **Recent data** (1-7 days old): 5 minute stale time, 30 minute cache
  - **Real-time data** (<1 day old): 1 minute stale time, 5 minute cache
- Automatic revalidation based on data freshness

**Usage:**
```tsx
import { NASAClient } from '@/services';

// Get query options for React Query
const queryOptions = NASAClient.getQueryOptions({
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-01-08'),
  orbitType: 'LEO',
  particleType: 'proton',
  resolution: 'hourly',
});

// Use with React Query
const { data } = useQuery(queryOptions);
```

### ERG/Arase Client (`erg-client.ts`)

**Features:**
- Optimized for static CSV files
- Long cache times (1 hour stale, 24 hour cache)
- File modification time tracking for cache invalidation
- No automatic refetching (CSV files don't change)

**Usage:**
```tsx
import { ERGClient } from '@/services';

const queryOptions = ERGClient.getQueryOptions('/data/erg-arase.csv');
const { data } = useQuery(queryOptions);
```

### CSES Client (`cses-client.ts`)

**Features:**
- Similar to ERG client
- Optimized for static CSV files
- Long cache times

## Caching Strategy

### React Query Configuration

#### Static Orbital Data (CSV files)
```tsx
{
  staleTime: 60 * 60 * 1000,      // 1 hour
  gcTime: 24 * 60 * 60 * 1000,    // 24 hours
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
}
```

#### Recent Historical Data (1-7 days)
```tsx
{
  staleTime: 5 * 60 * 1000,        // 5 minutes
  gcTime: 30 * 60 * 1000,         // 30 minutes
  refetchOnWindowFocus: false,
  refetchOnReconnect: true,
}
```

#### Real-time Data (<1 day)
```tsx
{
  staleTime: 60 * 1000,            // 1 minute
  gcTime: 5 * 60 * 1000,          // 5 minutes
  refetchInterval: 60000,          // Auto-refetch every minute
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
}
```

### Cache Key Strategy

Query keys are structured hierarchically:
```tsx
['nasa-omni', startDate, endDate, orbitType, particleType, energyRange, resolution]
['erg-arase', sourceUrl, lastModified]
['cses', sourceUrl, lastModified]
```

This ensures:
- Separate caches for different queries
- Automatic invalidation when parameters change
- Efficient cache sharing for identical queries

## Optimized Hook: `useRadiationDataOptimized`

The optimized hook uses service clients with proper caching:

```tsx
import { useRadiationDataOptimized } from '@/hooks/useRadiationDataOptimized';

const {
  measurements,
  filteredMeasurements,
  timeSeries,
  isLoading,
  error,
  refetch,
} = useRadiationDataOptimized({
  realTime: true,
  sources: ['nasa-omni', 'erg-arase'],
  csvSources: {
    'erg-arase': '/data/erg-arase.csv',
  },
});
```

**Benefits:**
- Automatic cache management per data source
- Parallel fetching with `useQueries`
- Optimized revalidation based on data type
- Reduced redundant API calls

## 3D Rendering Optimizations

### Level-of-Detail (LOD) System

The app implements a comprehensive LOD system to maintain 60fps:

#### LOD Levels

| LOD | Max Points | Point Size | Use Case |
|-----|------------|------------|----------|
| 0   | Unlimited  | 1.0x       | Small datasets, close-up view |
| 1   | 50,000     | 0.8x       | Medium datasets |
| 2   | 20,000     | 0.6x       | Large datasets |
| 3   | 5,000      | 0.4x       | Very large datasets, far view |

#### Automatic LOD Adjustment

The `useLOD` hook automatically adjusts LOD based on:
- **FPS performance**: Increases LOD if FPS drops below target
- **Dataset size**: Selects appropriate LOD for data volume
- **Camera distance**: Adjusts based on view distance (in LOD component)

**Usage:**
```tsx
import { useLOD } from '@/hooks/useLOD';

const { lodLevel, maxPoints, pointSize } = useLOD({
  datasetSize: data.length,
  targetFPS: 60,
  autoAdjust: true,
});
```

### Instanced Rendering

The `RadiationDataOverlayLOD` component uses:
- **THREE.Points** for efficient instanced rendering
- **BufferGeometry** with typed arrays for GPU-friendly data
- **Custom shaders** for glowing effects
- **Uniform downsampling** for LOD levels

**Performance Benefits:**
- Single draw call for all points
- GPU-accelerated rendering
- Minimal CPU overhead
- Maintains 60fps with 50k+ points

## Client-Side Component Markers

Components that use WebGL/Three.js are marked with `'use client'` directive:

- `SpaceScene.tsx`
- `Earth.tsx`
- `RadiationDataOverlay.tsx`
- `RadiationDataOverlayLOD.tsx`

This ensures:
- Proper code splitting
- Client-side only rendering
- Reduced bundle size for server-side rendering (if migrated to Next.js)

## Best Practices

### 1. Use Service Clients

Always use service clients instead of direct API calls:
```tsx
// ✅ Good
const queryOptions = NASAClient.getQueryOptions(options);
const { data } = useQuery(queryOptions);

// ❌ Bad
const data = await fetchOMNIData(params); // No caching
```

### 2. Leverage React Query Caching

Let React Query handle caching automatically:
```tsx
// ✅ Good - React Query manages cache
const { data } = useQuery(queryOptions);

// ❌ Bad - Manual state management
const [data, setData] = useState([]);
useEffect(() => { fetchData().then(setData); }, []);
```

### 3. Enable LOD for Large Datasets

Always enable LOD for datasets > 10,000 points:
```tsx
// ✅ Good
<SpaceScene
  data={data}
  enableLOD={true}
  lodLevel={autoLOD ? undefined : 2}
/>

// ❌ Bad - No LOD optimization
<SpaceScene data={data} />
```

### 4. Use Appropriate Cache Times

Match cache times to data characteristics:
- Static CSV files: Long cache (1+ hours)
- Historical API data: Medium cache (5-30 minutes)
- Real-time data: Short cache (1-5 minutes)

## Performance Monitoring

The app includes performance monitoring to track:
- FPS (target: 60fps)
- Dataset size
- Frame time
- Cache hit rates (via React Query DevTools)

Use `usePerformanceMonitor` hook to track performance:
```tsx
const { metrics, warning, error } = usePerformanceMonitor({
  datasetSize: data.length,
  fpsThreshold: 60,
});
```

## Migration Notes

### From `useRadiationData` to `useRadiationDataOptimized`

The optimized hook provides the same API with better caching:

```tsx
// Old
const data = useRadiationData({ sources: ['nasa-omni'] });

// New (same API, better caching)
const data = useRadiationDataOptimized({ sources: ['nasa-omni'] });
```

### Enabling LOD

To enable LOD optimization:
```tsx
<SpaceScene
  data={radiationData}
  enableLOD={true}  // Enable LOD
  lodLevel={undefined}  // Auto-adjust, or set manually (0-3)
/>
```

## Testing

### Cache Testing

1. Load data and verify cache hit
2. Change query parameters and verify new fetch
3. Wait for stale time and verify revalidation
4. Check React Query DevTools for cache status

### Performance Testing

1. Load large dataset (50k+ points)
2. Verify LOD auto-adjustment
3. Monitor FPS (should stay ~60fps)
4. Test with different LOD levels manually

### Load Testing

1. Test with multiple data sources simultaneously
2. Verify parallel fetching works correctly
3. Check memory usage with large caches
4. Test cache eviction (gcTime)

## Future Enhancements

- [ ] Service Worker for offline caching
- [ ] IndexedDB for persistent cache storage
- [ ] WebSocket for real-time data streaming
- [ ] Request deduplication
- [ ] Prefetching for predicted queries
- [ ] Cache compression for large datasets

