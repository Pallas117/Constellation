/**
 * Statistics display component for radiation data
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import type { RealTimeRadiationSnapshot } from '@/lib/types/radiation';
import { getAlertLevel } from '@/lib/utils/radiation';

interface RadiationStatisticsProps {
  statistics: {
    count: number;
    averageFlux: number;
    medianFlux: number;
    minFlux: number;
    maxFlux: number;
    stdDevFlux: number;
    averageAltitude: number;
    averageLShell: number;
    timeSpan: {
      start: string;
      end: string;
      duration: number;
    };
  };
  realTimeSnapshot?: RealTimeRadiationSnapshot | null;
  lastUpdate?: Date | null;
}

export function RadiationStatistics({
  statistics,
  realTimeSnapshot,
  lastUpdate,
}: RadiationStatisticsProps) {
  const formatFlux = (flux: number) => {
    if (flux === 0) return '0';
    return flux.toExponential(2);
  };

  const formatDuration = (ms: number) => {
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    if (days > 0) return `${days}d ${hours}h`;
    return `${hours}h`;
  };

  const alertLevel = realTimeSnapshot
    ? realTimeSnapshot.summary.alertLevel
    : getAlertLevel(statistics.averageFlux, 'electron');

  // WCAG 2.1 AA compliant alert colors
  const alertColors = {
    low: 'bg-green-600/20 text-green-700 dark:text-green-400 border-green-600/30 dark:border-green-500/30',
    moderate: 'bg-yellow-600/20 text-yellow-700 dark:text-yellow-400 border-yellow-600/30 dark:border-yellow-500/30',
    high: 'bg-orange-600/20 text-orange-700 dark:text-orange-400 border-orange-600/30 dark:border-orange-500/30',
    severe: 'bg-red-600/20 text-red-700 dark:text-red-400 border-red-600/30 dark:border-red-500/30',
  };

  return (
    <div className="grid gap-4 md:grid-cols-2" role="region" aria-label="Radiation data statistics">
      {/* Overall Statistics */}
      <Card>
        <CardHeader>
          <CardTitle>Data Statistics</CardTitle>
          <CardDescription>
            {lastUpdate && `Last updated ${formatDistanceToNow(lastUpdate, { addSuffix: true })}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Data Points</p>
              <p className="text-2xl font-bold">{statistics.count.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Time Span</p>
              <p className="text-2xl font-bold">{formatDuration(statistics.timeSpan.duration)}</p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Flux Statistics</p>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Average:</span>
                <span className="font-mono">{formatFlux(statistics.averageFlux)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Median:</span>
                <span className="font-mono">{formatFlux(statistics.medianFlux)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Min:</span>
                <span className="font-mono">{formatFlux(statistics.minFlux)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Max:</span>
                <span className="font-mono">{formatFlux(statistics.maxFlux)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Std Dev:</span>
                <span className="font-mono">{formatFlux(statistics.stdDevFlux)}</span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Orbital Parameters</p>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Avg Altitude:</span>
                <span className="font-mono">{statistics.averageAltitude.toFixed(0)} km</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Avg L-shell:</span>
                <span className="font-mono">{statistics.averageLShell.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Real-time Snapshot */}
      {realTimeSnapshot && (
        <Card>
          <CardHeader>
            <CardTitle>Real-time Status</CardTitle>
            <CardDescription>Current radiation conditions</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium">Alert Level</p>
                <Badge className={alertColors[alertLevel]}>{alertLevel.toUpperCase()}</Badge>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Current Flux</p>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Average:</span>
                  <span className="font-mono">
                    {formatFlux(realTimeSnapshot.summary.averageFlux)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Min:</span>
                  <span className="font-mono">{formatFlux(realTimeSnapshot.summary.minFlux)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Max:</span>
                  <span className="font-mono">{formatFlux(realTimeSnapshot.summary.maxFlux)}</span>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Active Orbits</p>
              <div className="flex gap-2">
                {realTimeSnapshot.summary.activeOrbits.map((orbit) => (
                  <Badge key={orbit} variant="outline">
                    {orbit}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="pt-2 text-xs text-muted-foreground">
              Snapshot: {formatDistanceToNow(new Date(realTimeSnapshot.timestamp), { addSuffix: true })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

