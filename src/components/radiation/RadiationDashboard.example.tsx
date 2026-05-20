/**
 * Example usage of the radiation data system
 * This file demonstrates how to use useRadiationData hook with the radiation components
 */

import { useRadiationData } from '@/hooks/useRadiationData';
import { RadiationChart, RadiationFilter, RadiationStatistics } from './index';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

export function RadiationDashboardExample() {
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
    updateInterval: 60000, // Update every minute
    sources: ['nasa-omni'], // Add 'spenvis', 'erg-arase', 'cses' as needed
    initialFilter: {
      orbitTypes: ['LEO', 'MEO', 'GEO'],
      particleTypes: ['proton', 'electron'],
      // startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // Last 7 days
      // endTime: new Date().toISOString(),
    },
    // csvSources: {
    //   'erg-arase': '/data/erg-arase.csv',
    //   'cses': '/data/cses.csv',
    // },
  });

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <RefreshCw className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-muted-foreground">Loading radiation data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="m-4">
        <CardHeader>
          <CardTitle>Error Loading Data</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-destructive">{error.message}</p>
          <Button onClick={() => refetch()} className="mt-4">
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Space Radiation Dashboard</h1>
          <p className="text-muted-foreground">
            Real-time and historical radiation data visualization
          </p>
        </div>
        <Button onClick={() => refetch()} variant="outline" size="sm">
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Statistics and Real-time Status */}
      <RadiationStatistics
        statistics={statistics}
        realTimeSnapshot={realTimeSnapshot}
        lastUpdate={lastUpdate}
      />

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Chart - Takes 2/3 of the width on large screens */}
        <div className="lg:col-span-2">
          <RadiationChart
            timeSeries={timeSeries}
            title="Radiation Flux Over Time"
            description={`Showing ${filteredMeasurements.length} data points across ${filter.orbitTypes?.length || 3} orbit types`}
            showLegend={true}
          />
        </div>

        {/* Filter Panel - Takes 1/3 of the width on large screens */}
        <div>
          <RadiationFilter
            filter={filter}
            onFilterChange={setFilter}
            onApply={() => refetch()}
          />
        </div>
      </div>

      {/* Data Summary */}
      <Card>
        <CardHeader>
          <CardTitle>Data Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Total Measurements</p>
              <p className="text-2xl font-bold">{statistics.count.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Filtered Measurements</p>
              <p className="text-2xl font-bold">{filteredMeasurements.length.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Time Series</p>
              <p className="text-2xl font-bold">{timeSeries.length}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Active Orbits</p>
              <p className="text-2xl font-bold">
                {realTimeSnapshot?.summary.activeOrbits.length || 0}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

