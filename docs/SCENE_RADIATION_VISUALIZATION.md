# Space Scene Radiation Visualization

This document describes how `SpaceScene` (`frontend/src/components/scene/SpaceScene.tsx`) draws orbit rings and radiation data points.

## Overview

Besides Earth, the belts, the magnetosphere and the field lines, `SpaceScene` can show:
1. **Orbit Rings** - Visual rings for LEO, MEO, and GEO orbits
2. **Radiation Data Overlay** - WebGL points for `RadiationDataPoint`s, drawn as glowing dots

**Where the data comes from today:** the only caller that passes radiation data is `/heliophysics` (`pages/HeliophysicsDashboard.tsx`). It passes the six-point mock storm in `frontend/src/data/mock_solar_storm.json` while "simulate storm" is on, and nothing otherwise. `GaussGlobe` (the public dashboard and `SpaceWeatherVisualization`) passes no `data`, so the overlay isn't mounted there. No live radiation feed exists yet; the live feeds the scene does use (solar wind drivers, MMS vectors) are described in [DATA_FETCHING_OPTIMIZATION.md](DATA_FETCHING_OPTIMIZATION.md).

## Components

### `SpaceScene`

The radiation-related props (see the file for the full list):

```tsx
interface SpaceSceneProps {
  layers: LayerVisibility;
  // ...scene props (magnetopauseCompression, beltIntensity, solarWindDrivers, view, ...)
  /** Radiation data points to visualize */
  data?: RadiationDataPoint[];
  /** Orbit types to display (LEO, MEO, GEO); default all three */
  orbitFilter?: string[];
  /** Callback when a radiation data point is clicked */
  onDataPointClick?: (point: RadiationDataPoint) => void;
  /** Use RadiationDataOverlayLOD (default: true) */
  enableLOD?: boolean;
  /** Manual LOD level (0-3); leave undefined for automatic LOD */
  lodLevel?: number;
  /** Encoding mode for radiation data: 'color' (default), 'size', or 'both' */
  encodingMode?: 'color' | 'size' | 'both';
}
```

The overlay is mounted only when `data` is non-empty. The scene mounts in stages, so the orbit rings and the overlay appear after Earth, the belts and the magnetosphere.

### `OrbitRings`

Renders wireframe circles at fixed altitudes for LEO (400 km), MEO (20,000 km), and GEO (35,786 km).

**Features:**
- Color-coded rings (blue to violet)
- Rings in `orbitFilter` are drawn at opacity 0.5, the others at 0.2
- Subtle rotation animation

### `RadiationDataOverlay` and `RadiationDataOverlayLOD`

Both render radiation data points as one `THREE.Points` object with a custom glow shader. `SpaceScene` uses `RadiationDataOverlayLOD` unless `enableLOD={false}`.

**Features (both):**
- **Filtering**: Points whose `orbitType` isn't in `orbitFilter` are dropped
- **Color Coding**: Blue (low flux) → pale green → Red (high flux); see [Color Mapping](#color-mapping)
- **Size Encoding**: Dot size always grows with flux (same log normalization as the colors); `size` and `both` modes use a wider size range so size alone can carry flux
- **Glowing Effect**: Pulsing glow in the fragment shader, additive blending, no depth writes
- **Position Calculation**: Uses latitude/longitude, or falls back to an L-shell-based placement

**`RadiationDataOverlayLOD` adds:**
- Four LOD levels that cap the point count and shrink the points (see [Performance Considerations](#performance-considerations))
- Automatic LOD from camera distance, checked every 100 ms, when `lodLevel` is undefined
- Uniform downsampling (every n-th point) when the data exceeds the level's cap
- `createGlowMaterial`, exported so `ShaderWarmup` can compile the shader before the first storm toggle

## Usage Example

How `/heliophysics` wires it (abridged):

```tsx
import { SpaceScene } from '@/components/scene/SpaceScene';
import type { RadiationDataPoint } from '@/lib/types/radiation';
import mockSolarStormData from '@/data/mock_solar_storm.json';

const STORM_RADIATION = mockSolarStormData as unknown as RadiationDataPoint[];

<SpaceScene
  layers={layers}
  magnetopauseCompression={visual.magnetopauseCompression}
  beltIntensity={visual.beltIntensity}
  reconnectionStrength={visual.reconnectionStrength}
  canvasRef={canvasRef}
  data={simulateStorm ? STORM_RADIATION : undefined}
  orbitFilter={['LEO', 'MEO', 'GEO']}
/>
```

## Data Format

The overlays take `RadiationDataPoint[]` from `frontend/src/lib/types/radiation.ts`:

```tsx
interface RadiationDataPoint {
  timestamp: string; // ISO 8601
  flux: number;
  altitude: number; // km
  L_shell: number;
  latitude?: number; // degrees
  longitude?: number; // degrees
  orbitType: OrbitType; // 'LEO' | 'MEO' | 'GEO'
  particleType: ParticleType; // 'proton' | 'electron' | 'alpha' | 'heavy_ion'
  energyRange: EnergyRange; // { min, max } in MeV
  radiationZone?: RadiationZone; // 'inner-belt-low' ... 'magnetosphere'
}
```

The type doesn't fix a unit for `flux`, and the overlays don't need one: they only compare points within the same dataset. The mock storm values are illustrative, not measurements. Whoever adds a real source should state the flux unit (differential vs integral, per sr or omnidirectional) where the data enters; the `space-radiation-physics` skill lists the units.

## Color Mapping

Radiation intensity is color-coded on a logarithmic scale, normalized to the dataset's own minimum and maximum flux (after orbit filtering and any LOD downsampling):

- **Blue** (`#0000ff`): Lowest flux in the dataset
- **Pale green** (`#80ff80`): Geometric middle of the range
- **Red** (`#ff0000`): Highest flux in the dataset

Red channel = t, blue = 1 − t, green peaks at t = 0.5, where t is the log-normalized flux. If every point has the same flux, all points get the middle color. Colors are therefore relative: the same flux can be blue in one dataset and red in another. In `size` mode the points are a fixed light blue and only the size carries flux.

## Performance Considerations

### WebGL Optimization

1. **Single draw call**: All data points are one `THREE.Points` object
2. **Shader-based**: Custom shaders for the glow and pulse
3. **Buffer Attributes**: Position, color, and size data stored in GPU buffers
4. **Additive Blending**: Glow without extra passes

### LOD levels (`RadiationDataOverlayLOD`)

| LOD | Camera distance (scene units, 1 = Earth radius) | Max points | Point size |
|-----|-----------------------------------------|------------|------------|
| 0   | ≤ 5                                     | Unlimited  | 0.10       |
| 1   | 5–10                                    | 50,000     | 0.08       |
| 2   | 10–15                                   | 20,000     | 0.06       |
| 3   | > 15                                    | 5,000      | 0.04       |

The `maxPoints` prop on the component overrides the level's cap. Nothing in the app measures frame rate to pick a level; distance is the only input.

## Layer Visibility

The radiation and orbit layers are on unless set to `false`:

```tsx
const layers: LayerVisibility = {
  earth: true,
  belts: true,           // Van Allen belts
  magnetosphere: true,
  fieldLines: true,
  mhdWaves: false,
  mmsReconnection: true,
  orbitRings: true,      // optional; omitted means shown
  radiationData: true,   // optional; omitted means shown
};
```

## Orbit Filtering

Filter which orbit types are displayed:

```tsx
// Show all orbits
orbitFilter={['LEO', 'MEO', 'GEO']}

// Show only LEO
orbitFilter={['LEO']}
```

The filter drops points from the overlay and dims the unselected orbit rings.

## Position Calculation

Positions are in Earth radii (radius = 1 + altitude / 6371 km):

1. **Latitude/Longitude** (if both are present): Direct geographic positioning
2. **Otherwise**: An angle derived from `L_shell` on a ring inclined 45°, at the point's altitude. This only spreads points out; it is not a physical L-shell mapping.

## Click Handling

`onDataPointClick` on `SpaceScene` is passed to the overlay as `onPointClick`. A pointer-down raycasts against the points and reports the nearest one within a small threshold. No page passes the callback at the moment.

## Future Enhancements

Potential improvements:
- A live radiation source (e.g. GOES integral proton and electron flux) to replace the mock storm
- Fixed, physically labelled color scale instead of per-dataset normalization
- Contour/isosurface rendering for continuous fields
- Time-based animation of data points
- Interactive tooltips showing flux values
