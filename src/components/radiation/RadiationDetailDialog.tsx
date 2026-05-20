/**
 * Radiation Detail Dialog Component
 * Shows detailed information when a data point is clicked
 */

import { Suspense, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, AlertCircle } from 'lucide-react';
import { RadiationChart } from './RadiationChart';
import { usePerformanceMonitor } from '@/hooks/usePerformanceMonitor';
import {
  getDoseRateFromMeasurement,
  getMagneticFieldFromMeasurement,
  formatSourceName,
} from '@/lib/utils/radiation-calculations';
import type { RadiationMeasurement, RadiationDataPoint, RadiationTimeSeries } from '@/lib/types/radiation';
import { createTimeSeries } from '@/lib/utils/radiation';

interface RadiationDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dataPoint: RadiationMeasurement | RadiationDataPoint | null;
  relatedData?: (RadiationMeasurement | RadiationDataPoint)[];
  timeSeries?: RadiationTimeSeries[];
}

/**
 * Chart component with suspense boundary
 */
function RadiationDetailChart({
  timeSeries,
  dataPoint,
}: {
  timeSeries?: RadiationTimeSeries[];
  dataPoint: RadiationMeasurement | RadiationDataPoint | null;
}) {
  if (!timeSeries || timeSeries.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground">
        No time series data available
      </div>
    );
  }

  return (
    <RadiationChart
      timeSeries={timeSeries}
      title="Radiation Flux History"
      description={`Time series for ${dataPoint?.orbitType || 'selected'} orbit`}
      showLegend={true}
    />
  );
}

/**
 * Skeleton loader for chart
 */
function ChartSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
      <div className="flex space-x-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-24" />
      </div>
    </div>
  );
}

export function RadiationDetailDialog({
  open,
  onOpenChange,
  dataPoint,
  relatedData = [],
  timeSeries,
}: RadiationDetailDialogProps) {
  // Performance monitoring
  const { warning, error } = usePerformanceMonitor({
    datasetSize: relatedData.length,
    enabled: open,
  });

  // Calculate derived values
  const detailData = useMemo(() => {
    if (!dataPoint) return null;

    const doseRate = getDoseRateFromMeasurement(dataPoint);
    const bField = getMagneticFieldFromMeasurement(dataPoint);

    // Get source name
    const source = 'source' in dataPoint ? dataPoint.source : 'unknown';
    const sourceName = formatSourceName(source);

    // Get instrument if available
    const instrument =
      'metadata' in dataPoint && dataPoint.metadata?.instrument
        ? dataPoint.metadata.instrument
        : undefined;

    return {
      flux: 'particleFlux' in dataPoint ? dataPoint.particleFlux : dataPoint.flux,
      doseRate,
      lShell: dataPoint.L_shell,
      bField,
      source,
      sourceName,
      instrument,
      altitude: dataPoint.altitude,
      particleType: dataPoint.particleType,
      energyRange: dataPoint.energyRange,
      timestamp: dataPoint.timestamp,
      latitude: 'latitude' in dataPoint ? dataPoint.latitude : undefined,
      longitude: 'longitude' in dataPoint ? dataPoint.longitude : undefined,
    };
  }, [dataPoint]);

  // Create time series from related data if not provided
  const chartTimeSeries = useMemo(() => {
    if (timeSeries) return timeSeries;

    if (!dataPoint || relatedData.length === 0) return [];

    try {
      // Filter related data to same orbit and particle type
      const filtered = relatedData.filter(
        (d) =>
          d.orbitType === dataPoint.orbitType &&
          d.particleType === dataPoint.particleType
      );

      if (filtered.length === 0) return [];

      // Convert to measurements if needed
      const measurements = filtered.map((d) => {
        if ('particleFlux' in d) return d as RadiationMeasurement;
        // Convert data point to measurement
        return {
          ...d,
          particleFlux: 'flux' in d ? d.flux : 0,
          source: 'source' in d ? d.source : 'unknown',
        } as RadiationMeasurement;
      });

      const series = createTimeSeries(
        measurements,
        dataPoint.orbitType,
        dataPoint.particleType,
        dataPoint.energyRange
      );

      return [series];
    } catch {
      return [];
    }
  }, [dataPoint, relatedData, timeSeries]);

  if (!dataPoint || !detailData) {
    return null;
  }

  // Format values for display
  const formatFlux = (flux: number) => {
    if (flux === 0) return '0';
    if (flux < 1e-3) return flux.toExponential(2);
    if (flux < 1) return flux.toFixed(4);
    if (flux < 1000) return flux.toFixed(2);
    return flux.toExponential(2);
  };

  const formatDoseRate = (dose: number) => {
    if (dose < 0.001) return `${(dose * 1000).toFixed(3)} µSv/h`;
    if (dose < 1) return `${(dose * 1000).toFixed(2)} µSv/h`;
    return `${dose.toFixed(3)} mSv/h`;
  };

  const formatBField = (b: number) => {
    if (b < 1000) return `${b.toFixed(1)} nT`;
    if (b < 1000000) return `${(b / 1000).toFixed(2)} µT`;
    return `${(b / 1000000).toFixed(2)} mT`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle>Radiation Measurement Details</DialogTitle>
            <Badge variant="outline" className="ml-2">
              {detailData.sourceName}
            </Badge>
          </div>
          <DialogDescription>
            {new Date(detailData.timestamp).toLocaleString()}
            {detailData.instrument && ` • Instrument: ${detailData.instrument}`}
          </DialogDescription>
        </DialogHeader>

        {/* Performance Warnings */}
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Performance Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {warning && !error && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Performance Warning</AlertTitle>
            <AlertDescription>{warning}</AlertDescription>
          </Alert>
        )}

        {/* Data Table */}
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold mb-2">Measurement Values</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Parameter</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Unit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-medium">Particle Flux</TableCell>
                  <TableCell className="font-mono">{formatFlux(detailData.flux)}</TableCell>
                  <TableCell>particles/(cm²·s·sr·MeV)</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Dose Rate</TableCell>
                  <TableCell className="font-mono">{formatDoseRate(detailData.doseRate)}</TableCell>
                  <TableCell>mSv/h</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">L-shell</TableCell>
                  <TableCell className="font-mono">{detailData.lShell.toFixed(3)}</TableCell>
                  <TableCell>dimensionless</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Magnetic Field (B)</TableCell>
                  <TableCell className="font-mono">{formatBField(detailData.bField)}</TableCell>
                  <TableCell>nT</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Altitude</TableCell>
                  <TableCell className="font-mono">{detailData.altitude.toFixed(1)}</TableCell>
                  <TableCell>km</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Orbit Type</TableCell>
                  <TableCell className="capitalize">{dataPoint.orbitType}</TableCell>
                  <TableCell>-</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Particle Type</TableCell>
                  <TableCell className="capitalize">{dataPoint.particleType}</TableCell>
                  <TableCell>-</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Energy Range</TableCell>
                  <TableCell className="font-mono">
                    {detailData.energyRange.min.toFixed(2)} - {detailData.energyRange.max.toFixed(2)}
                  </TableCell>
                  <TableCell>MeV</TableCell>
                </TableRow>
                {detailData.latitude !== undefined && detailData.longitude !== undefined && (
                  <>
                    <TableRow>
                      <TableCell className="font-medium">Latitude</TableCell>
                      <TableCell className="font-mono">{detailData.latitude.toFixed(2)}°</TableCell>
                      <TableCell>degrees</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="font-medium">Longitude</TableCell>
                      <TableCell className="font-mono">{detailData.longitude.toFixed(2)}°</TableCell>
                      <TableCell>degrees</TableCell>
                    </TableRow>
                  </>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Chart with Suspense */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Time Series</h3>
            <Suspense fallback={<ChartSkeleton />}>
              <RadiationDetailChart timeSeries={chartTimeSeries} dataPoint={dataPoint} />
            </Suspense>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

