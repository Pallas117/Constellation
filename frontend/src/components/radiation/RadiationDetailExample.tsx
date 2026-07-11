/**
 * Example usage of RadiationDetailDialog
 * Shows how to integrate click handling with the detail dialog
 */

import { useState, useCallback, useMemo, useRef } from 'react';
import { SpaceScene } from '@/components/scene/SpaceScene';
import { RadiationDetailDialog } from './RadiationDetailDialog';
import { useRadiationData } from '@/hooks/useRadiationData';
import { toDataPoint } from '@/lib/utils/radiation';
import type { RadiationDataPoint, RadiationMeasurement } from '@/lib/types/radiation';

export function RadiationDetailExample() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedPoint, setSelectedPoint] = useState<RadiationDataPoint | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Fetch radiation data
  const {
    filteredMeasurements,
    measurements,
    timeSeries,
    isLoading,
  } = useRadiationData({
    realTime: true,
    sources: ['nasa-omni'],
    initialFilter: {
      orbitTypes: ['LEO', 'MEO', 'GEO'],
      particleTypes: ['proton', 'electron'],
    },
  });

  // Convert to data points
  const radiationData: RadiationDataPoint[] = useMemo(() => {
    if (!filteredMeasurements || filteredMeasurements.length === 0) return [];
    return filteredMeasurements.map(toDataPoint);
  }, [filteredMeasurements]);

  // Handle data point click
  const handleDataPointClick = useCallback((point: RadiationDataPoint) => {
    setSelectedPoint(point);
    setDialogOpen(true);
  }, []);

  // Get related data for the selected point
  const relatedData = useMemo(() => {
    if (!selectedPoint || !measurements) return [];

    // Find measurements with same orbit type and particle type
    return measurements.filter(
      (m) =>
        m.orbitType === selectedPoint.orbitType &&
        m.particleType === selectedPoint.particleType
    );
  }, [selectedPoint, measurements]);

  // Get time series for selected point
  const selectedTimeSeries = useMemo(() => {
    if (!selectedPoint) return undefined;

    return timeSeries.filter(
      (ts) =>
        ts.orbitType === selectedPoint.orbitType &&
        ts.particleType === selectedPoint.particleType
    );
  }, [selectedPoint, timeSeries]);

  // Convert selected point to measurement if needed
  const selectedMeasurement = useMemo(() => {
    if (!selectedPoint) return null;

    // Find matching measurement
    const measurement = measurements?.find(
      (m) =>
        m.timestamp === selectedPoint.timestamp &&
        m.orbitType === selectedPoint.orbitType &&
        m.particleType === selectedPoint.particleType
    );

    if (measurement) return measurement;

    // Convert data point to measurement format
    return {
      ...selectedPoint,
      particleFlux: selectedPoint.flux,
      source: 'unknown' as const,
    } as RadiationMeasurement;
  }, [selectedPoint, measurements]);

  return (
    <div className="relative w-full h-full overflow-hidden">
      {/* 3D Scene */}
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
        orbitFilter={['LEO', 'MEO', 'GEO']}
        onDataPointClick={handleDataPointClick}
      />

      {/* Detail Dialog */}
      {selectedMeasurement && (
        <RadiationDetailDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          dataPoint={selectedMeasurement}
          relatedData={relatedData}
          timeSeries={selectedTimeSeries}
        />
      )}

      {/* Instructions */}
      <div className="absolute bottom-6 left-6 bg-background/80 backdrop-blur-sm rounded-lg p-4 border pointer-events-auto">
        <p className="text-sm text-muted-foreground">
          {isLoading ? 'Loading data...' : 'Click on a radiation data point to view details'}
        </p>
      </div>
    </div>
  );
}

