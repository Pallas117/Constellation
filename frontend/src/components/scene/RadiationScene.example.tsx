/**
 * Example usage of SpaceScene with radiation data
 * Demonstrates how to integrate radiation measurements with the 3D scene
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import { SpaceScene } from './SpaceScene';
import { useRadiationData } from '@/hooks/useRadiationData';
import { toDataPoint } from '@/lib/utils/radiation';
import type { RadiationDataPoint } from '@/lib/types/radiation';

interface LayerVisibility {
  earth: boolean;
  belts: boolean;
  magnetosphere: boolean;
  fieldLines: boolean;
  orbitRings?: boolean;
  radiationData?: boolean;
}

export const RadiationSceneExample = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const [layers, setLayers] = useState<LayerVisibility>({
    earth: true,
    belts: true,
    magnetosphere: true,
    fieldLines: true,
    orbitRings: true,
    radiationData: true,
  });

  const [orbitFilter, setOrbitFilter] = useState<string[]>(['LEO', 'MEO', 'GEO']);

  // Fetch radiation data
  const {
    filteredMeasurements,
    filter,
    setFilter,
    isLoading,
    error,
  } = useRadiationData({
    realTime: true,
    updateInterval: 60000,
    sources: ['nasa-omni'],
    initialFilter: {
      orbitTypes: ['LEO', 'MEO', 'GEO'],
      particleTypes: ['proton', 'electron'],
    },
  });

  // Convert measurements to data points for visualization
  const radiationData: RadiationDataPoint[] = useMemo(() => {
    if (!filteredMeasurements || filteredMeasurements.length === 0) return [];
    return filteredMeasurements.map(toDataPoint);
  }, [filteredMeasurements]);

  const handleToggle = useCallback((layer: keyof LayerVisibility) => {
    setLayers(prev => ({ ...prev, [layer]: !prev[layer] }));
  }, []);

  const handleOrbitFilterChange = useCallback((orbit: string) => {
    setOrbitFilter(prev => {
      if (prev.includes(orbit)) {
        return prev.filter(o => o !== orbit);
      }
      return [...prev, orbit];
    });
  }, []);

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* 3D Scene with Radiation Data */}
      <SpaceScene
        layers={layers}
        magnetopauseCompression={0.8}
        beltIntensity={0.5}
        reconnectionStrength={0.3}
        canvasRef={canvasRef}
        data={radiationData}
        orbitFilter={orbitFilter}
      />

      {/* UI Overlays */}
      <div className="absolute inset-0 pointer-events-none">
        {/* Top left - Title */}
        <div className="absolute top-6 left-6">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Space Radiation Visualization
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Real-time radiation data in Earth's orbit
          </p>
        </div>

        {/* Top right - Status */}
        <div className="absolute top-6 right-6 pointer-events-auto">
          <div className="bg-background/80 backdrop-blur-sm rounded-lg p-4 border">
            <div className="text-sm space-y-2">
              <div>
                <span className="text-muted-foreground">Data Points: </span>
                <span className="font-mono">{radiationData.length}</span>
              </div>
              {isLoading && (
                <div className="text-muted-foreground">Loading...</div>
              )}
              {error && (
                <div className="text-destructive">Error: {error.message}</div>
              )}
            </div>
          </div>
        </div>

        {/* Right side - Layer toggles */}
        <div className="absolute right-6 top-1/2 -translate-y-1/2 pointer-events-auto">
          <div className="bg-background/80 backdrop-blur-sm rounded-lg p-4 border space-y-4">
            <div className="text-sm font-medium">Layers</div>
            {Object.keys(layers).map((layer) => (
              <label key={layer} className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={layers[layer as keyof LayerVisibility] ?? false}
                  onChange={() => handleToggle(layer as keyof LayerVisibility)}
                  className="rounded"
                />
                <span className="text-sm capitalize">{layer}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Bottom left - Orbit Filter */}
        <div className="absolute bottom-6 left-6 pointer-events-auto">
          <div className="bg-background/80 backdrop-blur-sm rounded-lg p-4 border">
            <div className="text-sm font-medium mb-2">Orbit Filter</div>
            <div className="space-y-2">
              {['LEO', 'MEO', 'GEO'].map((orbit) => (
                <label key={orbit} className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={orbitFilter.includes(orbit)}
                    onChange={() => handleOrbitFilterChange(orbit)}
                    className="rounded"
                  />
                  <span className="text-sm">{orbit}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom right - Legend */}
        <div className="absolute bottom-6 right-6 pointer-events-auto">
          <div className="bg-background/80 backdrop-blur-sm rounded-lg p-4 border">
            <div className="text-sm font-medium mb-2">Radiation Intensity</div>
            <div className="flex items-center space-x-2">
              <div className="w-4 h-4 rounded-full bg-blue-500"></div>
              <span className="text-xs">Low</span>
              <div className="flex-1 h-2 bg-gradient-to-r from-blue-500 via-yellow-500 to-red-500 rounded"></div>
              <div className="w-4 h-4 rounded-full bg-red-500"></div>
              <span className="text-xs">High</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

