# Space Scene Radiation Visualization

This document describes the updated `SpaceScene` component with integrated radiation data visualization.

## Overview

The `SpaceScene` component has been enhanced to display:
1. **3D Earth Globe** - Rotating Earth with atmosphere glow
2. **Orbit Rings** - Visual rings for LEO, MEO, and GEO orbits
3. **Radiation Data Overlay** - WebGL-based visualization of radiation measurements as glowing dots/contours

## Components

### `SpaceScene` (Updated)

The main scene component now accepts radiation data props:

```tsx
interface SpaceSceneProps {
  layers: LayerVisibility;
  magnetopauseCompression: number;
  beltIntensity: number;
  reconnectionStrength: number;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  /** NEW: Radiation data points to visualize */
  data?: RadiationDataPoint[];
  /** NEW: Orbit types to display (LEO, MEO, GEO) */
  orbitFilter?: string[];
}
```

### `OrbitRings`

Renders wireframe circles at appropriate altitudes for LEO (400 km), MEO (20,000 km), and GEO (35,786 km).

**Features:**
- Color-coded rings (blue tones)
- Opacity based on filter selection
- Subtle rotation animation
- Filtered by `orbitFilter` prop

### `RadiationDataOverlay`

WebGL-based component that renders radiation measurements as glowing dots on the orbit rings.

**Features:**
- **Performance**: Uses instanced rendering with shaders
- **Color Coding**: Blue (low flux) → Yellow → Red (high flux)
- **Glowing Effect**: Animated pulsing glow using custom shaders
- **Size Scaling**: Dot size proportional to flux value (logarithmic scale)
- **Position Calculation**: Uses altitude, latitude/longitude, or L-shell for positioning

**Technical Details:**
- Custom shader material with vertex and fragment shaders
- Additive blending for glow effect
- Logarithmic color mapping for better visualization
- Automatic min/max normalization

## Usage Example

```tsx
import { SpaceScene } from '@/components/scene/SpaceScene';
import { useRadiationData } from '@/hooks/useRadiationData';
import { toDataPoint } from '@/lib/utils/radiation';

function MyRadiationVisualization() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [orbitFilter, setOrbitFilter] = useState<string[]>(['LEO', 'MEO', 'GEO']);

  // Fetch radiation data
  const { filteredMeasurements } = useRadiationData({
    realTime: true,
    sources: ['nasa-omni'],
  });

  // Convert to data points
  const radiationData = useMemo(() => {
    return filteredMeasurements.map(toDataPoint);
  }, [filteredMeasurements]);

  return (
    <SpaceScene
      layers={{
        earth: true,
        belts: true,
        magnetosphere: true,
        fieldLines: true,
        orbitRings: true,
        radiationData: true,
      }}
      magnetopauseCompression={0.8}
      beltIntensity={0.5}
      reconnectionStrength={0.3}
      canvasRef={canvasRef}
      data={radiationData}
      orbitFilter={orbitFilter}
    />
  );
}
```

## Data Format

The component expects `RadiationDataPoint[]`:

```tsx
interface RadiationDataPoint {
  timestamp: string;
  flux: number; // particles/(cm²·s·sr·MeV)
  altitude: number; // km
  L_shell: number;
  latitude?: number; // degrees
  longitude?: number; // degrees
  orbitType: 'LEO' | 'MEO' | 'GEO';
  particleType: 'proton' | 'electron' | 'alpha' | 'heavy_ion';
  energyRange: { min: number; max: number };
}
```

## Color Mapping

Radiation intensity is color-coded using a logarithmic scale:

- **Blue** (`#0000ff`): Low flux (minimum in dataset)
- **Cyan** (`#00ffff`): Low-medium
- **Yellow** (`#ffff00`): Medium-high
- **Red** (`#ff0000`): High flux (maximum in dataset)

The color interpolation uses logarithmic normalization to better represent the wide range of flux values typically seen in space radiation data.

## Performance Considerations

### WebGL Optimization

1. **Instanced Rendering**: All data points are rendered in a single draw call using `THREE.Points`
2. **Shader-based**: Custom shaders for efficient rendering
3. **Buffer Attributes**: Position, color, and size data stored in GPU buffers
4. **Additive Blending**: Efficient glow effect without additional passes

### Recommended Data Limits

- **Optimal**: < 10,000 points
- **Acceptable**: 10,000 - 50,000 points
- **May need optimization**: > 50,000 points

For large datasets, consider:
- Downsampling data
- Using time-based filtering
- Implementing level-of-detail (LOD) based on zoom level

## Layer Visibility

Control visibility of scene elements:

```tsx
const layers = {
  earth: true,           // 3D Earth globe
  belts: true,           // Van Allen belts
  magnetosphere: true,   // Magnetosphere visualization
  fieldLines: true,      // Magnetic field lines
  orbitRings: true,      // Orbit rings (LEO, MEO, GEO)
  radiationData: true,   // Radiation data overlay
};
```

## Orbit Filtering

Filter which orbit types are displayed:

```tsx
// Show all orbits
orbitFilter={['LEO', 'MEO', 'GEO']}

// Show only LEO
orbitFilter={['LEO']}

// Show LEO and GEO
orbitFilter={['LEO', 'GEO']}
```

## Position Calculation

The component calculates 3D positions using the following priority:

1. **Latitude/Longitude** (if available): Direct geographic positioning
2. **L-shell + Altitude**: Distributes points around orbit based on L-shell parameter
3. **Default**: Uses orbit altitude with 45° inclination

## Example Component

See `src/components/scene/RadiationScene.example.tsx` for a complete example implementation with:
- Data fetching using `useRadiationData`
- Layer toggles
- Orbit filtering
- Status display
- Color legend

## Integration with Existing Components

The updated `SpaceScene` is backward compatible. Existing usage will continue to work:

```tsx
// Old usage (still works)
<SpaceScene
  layers={layers}
  magnetopauseCompression={compression}
  beltIntensity={intensity}
  reconnectionStrength={strength}
  canvasRef={canvasRef}
/>

// New usage with radiation data
<SpaceScene
  {...existingProps}
  data={radiationData}
  orbitFilter={['LEO', 'MEO', 'GEO']}
/>
```

## Future Enhancements

Potential improvements:
- Contour/isosurface rendering for continuous fields
- Time-based animation of data points
- Interactive tooltips showing flux values
- Heat map texture on orbit rings
- Particle trails showing movement
- Level-of-detail (LOD) system for large datasets

