# Radiation Detail Component

This document describes the `RadiationDetailDialog` component that displays detailed information when a radiation data point is clicked.

## Overview

The `RadiationDetailDialog` component provides:
1. **Live Data Table** - Numerical values (flux, dose rate, L-shell, B-field, etc.)
2. **Dataset Source Badge** - Shows the data source (e.g., 'ERG', 'GOES-18', 'CSES')
3. **Time Series Chart** - With suspense boundary and skeleton loader
4. **Performance Warnings** - Alerts for large datasets or low FPS

## Components

### `RadiationDetailDialog`

Main dialog component that displays radiation measurement details.

**Props:**
```tsx
interface RadiationDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dataPoint: RadiationMeasurement | RadiationDataPoint | null;
  relatedData?: (RadiationMeasurement | RadiationDataPoint)[];
  timeSeries?: RadiationTimeSeries[];
}
```

### `usePerformanceMonitor` Hook

Monitors FPS and dataset size, providing warnings and errors.

**Usage:**
```tsx
const { metrics, warning, error } = usePerformanceMonitor({
  datasetSize: data.length,
  fpsThreshold: 60,
  datasetThreshold: 50000,
  enabled: true,
});
```

**Returns:**
- `metrics`: Performance metrics (FPS, frame time, dataset size, flags)
- `warning`: Warning message if performance is degraded
- `error`: Error message if performance is critically low

## Features

### 1. Live Data Table

Displays comprehensive measurement values:
- **Particle Flux**: particles/(cm²·s·sr·MeV)
- **Dose Rate**: Calculated from flux and energy (mSv/h or µSv/h)
- **L-shell**: McIlwain L parameter
- **Magnetic Field (B)**: Estimated from L-shell and altitude (nT)
- **Altitude**: km
- **Orbit Type**: LEO, MEO, or GEO
- **Particle Type**: proton, electron, alpha, heavy_ion
- **Energy Range**: MeV
- **Latitude/Longitude**: If available

### 2. Dataset Source Badge

Shows the data source with formatted names:
- `nasa-omni` → "NASA OMNI"
- `erg-arase` → "ERG/Arase"
- `cses` → "CSES"
- `goes-18` → "GOES-18"
- etc.

### 3. Time Series Chart with Suspense

The chart component is wrapped in a `Suspense` boundary with a skeleton loader:
- Shows loading state while data is being fetched
- Automatically creates time series from related data if not provided
- Filters data by orbit type and particle type

### 4. Performance Monitoring

#### Warnings
- **Large Dataset**: Warns if dataset exceeds threshold (default: 50,000 points)
- **Low FPS**: Warns if FPS drops below 60 but above 30

#### Errors
- **Critical FPS**: Error if FPS drops below 30
- **Very Large Dataset**: Error if dataset exceeds 2x threshold

## Usage Example

```tsx
import { useState, useCallback } from 'react';
import { SpaceScene } from '@/components/scene/SpaceScene';
import { RadiationDetailDialog } from '@/components/radiation/RadiationDetailDialog';
import { useRadiationData } from '@/hooks/useRadiationData';
import { toDataPoint } from '@/lib/utils/radiation';

function MyComponent() {
  const [selectedPoint, setSelectedPoint] = useState<RadiationDataPoint | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { filteredMeasurements, measurements, timeSeries } = useRadiationData({
    realTime: true,
    sources: ['nasa-omni'],
  });

  const radiationData = useMemo(() => {
    return filteredMeasurements.map(toDataPoint);
  }, [filteredMeasurements]);

  const handleDataPointClick = useCallback((point: RadiationDataPoint) => {
    setSelectedPoint(point);
    setDialogOpen(true);
  }, []);

  // Get related data
  const relatedData = useMemo(() => {
    if (!selectedPoint || !measurements) return [];
    return measurements.filter(
      (m) =>
        m.orbitType === selectedPoint.orbitType &&
        m.particleType === selectedPoint.particleType
    );
  }, [selectedPoint, measurements]);

  return (
    <>
      <SpaceScene
        data={radiationData}
        orbitFilter={['LEO', 'MEO', 'GEO']}
        onDataPointClick={handleDataPointClick}
        // ... other props
      />

      {selectedPoint && (
        <RadiationDetailDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          dataPoint={selectedPoint}
          relatedData={relatedData}
          timeSeries={timeSeries}
        />
      )}
    </>
  );
}
```

## Click Detection

The `RadiationDataOverlay` component supports click detection via the `onPointClick` callback:

```tsx
<RadiationDataOverlay
  data={data}
  orbitFilter={['LEO', 'MEO', 'GEO']}
  visible={true}
  onPointClick={(point, index) => {
    console.log('Clicked point:', point);
    // Open dialog, update state, etc.
  }}
/>
```

Click detection uses raycasting to find the nearest data point within a threshold distance.

## Calculations

### Dose Rate

Calculated from particle flux, energy range, and particle type:
```tsx
doseRate = flux × avgEnergy × conversionFactor × 3600 // mSv/h
```

Conversion factors vary by particle type:
- Protons: ~1.0e-6
- Electrons: ~5.0e-7
- Alpha particles: ~2.0e-6
- Heavy ions: ~3.0e-6

### Magnetic Field

Estimated from L-shell and altitude using simplified dipole field model:
```tsx
B ≈ M / (L × R_E)³
```

Where:
- M = Earth's magnetic dipole moment (~7.94e22 A·m²)
- L = L-shell parameter
- R_E = Earth radius

## Performance Considerations

### Recommended Limits
- **Optimal**: < 10,000 data points
- **Acceptable**: 10,000 - 50,000 points
- **Warning**: 50,000 - 100,000 points
- **Error**: > 100,000 points

### Optimization Tips
1. Filter data before passing to dialog
2. Use time-based filtering for large datasets
3. Limit related data to recent measurements
4. Consider downsampling for visualization

## Styling

The component uses ShadCN/ui components for consistent styling:
- `Dialog` for the modal
- `Table` for data display
- `Badge` for source labels
- `Alert` for warnings/errors
- `Skeleton` for loading states

All components follow the app's theme and can be customized via Tailwind classes.

## Future Enhancements

Potential improvements:
- Export data to CSV/JSON
- Compare multiple data points
- Historical trend analysis
- Interactive chart zoom/pan
- Customizable units
- Data quality indicators
- Uncertainty visualization

