# Space Radiation Data Structure

This document describes the project structure for the space radiation web app, focusing on visualizing real-time and historical radiation data in Earth's orbit (LEO, MEO, GEO).

## Project Structure

```
src/
├── lib/
│   ├── types/
│   │   ├── radiation.ts          # Type definitions for radiation measurements
│   │   └── index.ts              # Central type exports
│   ├── api/
│   │   ├── nasa-omni.ts          # NASA OMNI API client
│   │   ├── spenvis.ts            # SPENVIS API client
│   │   ├── csv-parsers.ts        # CSV parsers for ERG/Arase and CSES
│   │   └── index.ts              # Central API exports
│   ├── utils/
│   │   ├── radiation.ts          # Radiation data processing utilities
│   │   └── index.ts              # Central utility exports
│   └── utils.ts                  # General utilities (cn, etc.)
├── hooks/
│   ├── useRadiationData.ts       # Main hook for radiation data management
│   └── ...                       # Other hooks
├── components/
│   ├── radiation/                # Radiation-specific components
│   │   ├── RadiationChart.tsx    # Recharts visualization component
│   │   ├── RadiationFilter.tsx   # Data filtering UI
│   │   ├── RadiationStatistics.tsx # Statistics display
│   │   └── index.ts              # Component exports
│   ├── ui/                       # ShadCN/ui components
│   └── ...                       # Other components
└── pages/                        # Page components
```

## Type Definitions

### Core Types (`lib/types/radiation.ts`)

#### `RadiationMeasurement`
The core interface for a single radiation measurement:
- `timestamp`: ISO 8601 timestamp
- `particleFlux`: Particle flux in particles/(cm²·s·sr·MeV)
- `altitude`: Altitude in kilometers
- `L_shell`: L-shell parameter (McIlwain L)
- `latitude` / `longitude`: Optional geographic coordinates
- `particleType`: 'proton' | 'electron' | 'alpha' | 'heavy_ion'
- `energyRange`: Energy range in MeV
- `orbitType`: 'LEO' | 'MEO' | 'GEO'
- `source`: Data source identifier
- `metadata`: Optional metadata

#### `RadiationDataFilter`
Filter parameters for querying radiation data:
- Time range (startTime, endTime)
- Orbit types, particle types
- Energy range, L-shell range, altitude range
- Data sources
- Result limit

## Data Sources

### 1. NASA OMNI (`lib/api/nasa-omni.ts`)
- **Purpose**: Solar wind and radiation data from NASA's OMNI database
- **Function**: `fetchOMNIData(params: OMNIQueryParams)`
- **Returns**: Array of `RadiationMeasurement`
- **Note**: API endpoint may need adjustment based on actual OMNI web service

### 2. SPENVIS (`lib/api/spenvis.ts`)
- **Purpose**: Space environment and radiation data
- **Function**: `fetchSPENVISData(params: SPENVISQueryParams)`
- **Returns**: Array of `RadiationMeasurement`
- **Note**: May require authentication or web interface adaptation

### 3. ERG/Arase CSV (`lib/api/csv-parsers.ts`)
- **Purpose**: Parse ERG/Arase satellite data from CSV files
- **Function**: `parseERGAraseCSV(csvContent, options)`
- **Usage**: `loadRadiationCSV(fileOrUrl, 'erg-arase')`

### 4. CSES CSV (`lib/api/csv-parsers.ts`)
- **Purpose**: Parse CSES (China Seismo-Electromagnetic Satellite) data from CSV files
- **Function**: `parseCSESCSV(csvContent, options)`
- **Usage**: `loadRadiationCSV(fileOrUrl, 'cses')`

## Custom Hook: `useRadiationData`

### Basic Usage

```tsx
import { useRadiationData } from '@/hooks/useRadiationData';

function RadiationDashboard() {
  const {
    measurements,
    filteredMeasurements,
    filter,
    setFilter,
    timeSeries,
    realTimeSnapshot,
    statistics,
    isLoading,
    error,
    refetch,
  } = useRadiationData({
    realTime: true,
    updateInterval: 60000, // 1 minute
    sources: ['nasa-omni', 'spenvis'],
    csvSources: {
      'erg-arase': '/data/erg-arase.csv',
      'cses': '/data/cses.csv',
    },
  });

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      {/* Your UI here */}
    </div>
  );
}
```

### Options

- `realTime`: Enable automatic updates (default: false)
- `updateInterval`: Update interval in milliseconds (default: 60000)
- `initialFilter`: Initial filter parameters
- `sources`: Array of data sources to fetch from
- `csvSources`: Object mapping source names to CSV file URLs or File objects
- `enableCache`: Enable React Query caching (default: true)

### Return Values

- `measurements`: All fetched measurements
- `filteredMeasurements`: Measurements filtered by current filter
- `filter`: Current filter parameters
- `setFilter`: Function to update filter
- `timeSeries`: Array of time series data for visualization
- `realTimeSnapshot`: Current real-time snapshot (if realTime enabled)
- `statistics`: Calculated statistics for current data
- `isLoading`: Loading state
- `error`: Error state
- `refetch`: Manual refetch function
- `lastUpdate`: Last update timestamp

## Utility Functions (`lib/utils/radiation.ts`)

### Filtering
- `filterRadiationData(data, filter)`: Filter measurements by criteria

### Time Series
- `createTimeSeries(measurements, orbitType?, particleType?, energyRange?)`: Create time series from measurements
- `interpolateTimeSeries(timeSeries, intervalMs)`: Interpolate missing data points

### Statistics
- `calculateStatistics(measurements)`: Calculate comprehensive statistics
- `getAlertLevel(flux, particleType)`: Determine alert level based on flux

### Grouping
- `groupByOrbitType(measurements)`: Group by orbit type
- `groupByParticleType(measurements)`: Group by particle type

## Components

### `RadiationChart`
Recharts-based line chart for visualizing radiation flux over time.

```tsx
import { RadiationChart } from '@/components/radiation';

<RadiationChart
  timeSeries={timeSeries}
  title="Radiation Flux Over Time"
  description="LEO, MEO, and GEO measurements"
  showLegend={true}
/>
```

### `RadiationFilter`
Interactive filter UI for configuring data queries.

```tsx
import { RadiationFilter } from '@/components/radiation';

<RadiationFilter
  filter={filter}
  onFilterChange={setFilter}
  onApply={() => refetch()}
/>
```

### `RadiationStatistics`
Display statistics and real-time status.

```tsx
import { RadiationStatistics } from '@/components/radiation';

<RadiationStatistics
  statistics={statistics}
  realTimeSnapshot={realTimeSnapshot}
  lastUpdate={lastUpdate}
/>
```

## Example: Complete Dashboard

```tsx
import { useRadiationData } from '@/hooks/useRadiationData';
import { RadiationChart, RadiationFilter, RadiationStatistics } from '@/components/radiation';

function RadiationDashboard() {
  const {
    filteredMeasurements,
    filter,
    setFilter,
    timeSeries,
    realTimeSnapshot,
    statistics,
    isLoading,
    error,
    refetch,
    lastUpdate,
  } = useRadiationData({
    realTime: true,
    sources: ['nasa-omni'],
    initialFilter: {
      orbitTypes: ['LEO', 'MEO', 'GEO'],
      particleTypes: ['proton', 'electron'],
    },
  });

  if (isLoading) {
    return <div>Loading radiation data...</div>;
  }

  if (error) {
    return <div>Error: {error.message}</div>;
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <h1 className="text-3xl font-bold">Space Radiation Dashboard</h1>
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <RadiationChart
            timeSeries={timeSeries}
            title="Radiation Flux Over Time"
          />
        </div>
        
        <div>
          <RadiationFilter
            filter={filter}
            onFilterChange={setFilter}
            onApply={() => refetch()}
          />
        </div>
      </div>
      
      <RadiationStatistics
        statistics={statistics}
        realTimeSnapshot={realTimeSnapshot}
        lastUpdate={lastUpdate}
      />
    </div>
  );
}
```

## Data Flow

1. **Fetch**: `useRadiationData` hook fetches from configured sources
2. **Transform**: Raw API/CSV data is converted to `RadiationMeasurement` format
3. **Filter**: Measurements are filtered based on `RadiationDataFilter`
4. **Process**: Utilities process data (statistics, time series, etc.)
5. **Visualize**: Components render the processed data

## Notes

- All timestamps are in ISO 8601 format
- Flux values are in particles/(cm²·s·sr·MeV) or particles/(cm²·s)
- API endpoints in `nasa-omni.ts` and `spenvis.ts` are placeholders and may need adjustment
- CSV parsers assume standard formats but can be customized via options
- React Query handles caching and automatic refetching
- Components use ShadCN/ui for consistent styling

## Future Enhancements

- WebSocket support for real-time streaming
- Advanced interpolation algorithms
- Export functionality (CSV, JSON)
- 3D visualization components
- Historical data comparison
- Alert notifications
- Data aggregation and downsampling for large datasets

