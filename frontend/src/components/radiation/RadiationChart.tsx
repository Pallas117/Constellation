/**
 * Radiation data visualization component using Recharts
 */

import { useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { RadiationTimeSeries } from '@/lib/types/radiation';
import { format } from 'date-fns';

interface RadiationChartProps {
  timeSeries: RadiationTimeSeries[];
  title?: string;
  description?: string;
  showLegend?: boolean;
}

export function RadiationChart({
  timeSeries,
  title = 'Radiation Flux Over Time',
  description,
  showLegend = true,
}: RadiationChartProps) {
  // Transform time series data for Recharts
  const chartData = useMemo(() => {
    if (timeSeries.length === 0) return [];

    // Combine all time series into a single dataset
    const dataMap = new Map<string, Record<string, unknown>>();

    timeSeries.forEach((series) => {
      series.data.forEach((point) => {
        const timeKey = point.timestamp;
        if (!dataMap.has(timeKey)) {
          dataMap.set(timeKey, {
            timestamp: timeKey,
            time: format(new Date(timeKey), 'MMM dd, HH:mm'),
          });
        }

        const dataPoint = dataMap.get(timeKey)!;
        const seriesKey = `${series.orbitType}-${series.particleType}`;
        dataPoint[seriesKey] = point.flux;
      });
    });

    return Array.from(dataMap.values()).sort(
      (a, b) => new Date(a.timestamp as string).getTime() - new Date(b.timestamp as string).getTime()
    );
  }, [timeSeries]);

  // Generate WCAG 2.1 AA compliant line colors for different series
  // Colors chosen for good contrast against both light and dark backgrounds
  const getLineColor = (index: number) => {
    const colors = [
      '#2563eb', // blue-600 (WCAG AA compliant)
      '#dc2626', // red-600 (WCAG AA compliant)
      '#059669', // green-600 (WCAG AA compliant)
      '#d97706', // amber-600 (WCAG AA compliant)
      '#7c3aed', // purple-600 (WCAG AA compliant)
      '#db2777', // pink-600 (WCAG AA compliant)
    ];
    return colors[index % colors.length];
  };

  if (chartData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>
          <div className="flex h-64 items-center justify-center text-muted-foreground">
            No data available
          </div>
        </CardContent>
      </Card>
    );
  }

  // Generate accessible textual summary
  const generateSummary = () => {
    if (chartData.length === 0) return 'No data available';
    
    const summaries = timeSeries.map((series) => {
      const seriesKey = `${series.orbitType}-${series.particleType}`;
      const values = chartData
        .map((d) => d[seriesKey] as number)
        .filter((v) => v !== undefined && v !== null) as number[];
      
      if (values.length === 0) return null;
      
      const min = Math.min(...values);
      const max = Math.max(...values);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const firstTime = chartData[0]?.time as string;
      const lastTime = chartData[chartData.length - 1]?.time as string;
      
      return `${series.orbitType} ${series.particleType}: minimum flux ${min.toExponential(2)}, maximum ${max.toExponential(2)}, average ${avg.toExponential(2)} particles per square centimeter per second per steradian per MeV, from ${firstTime} to ${lastTime}`;
    }).filter(Boolean);
    
    return summaries.join('. ');
  };

  const chartSummary = generateSummary();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <div
          role="img"
          aria-label={`${title}. ${description || ''} ${chartSummary}`}
          aria-describedby="chart-description"
        >
          <ResponsiveContainer width="100%" height={400}>
            <LineChart 
              data={chartData} 
              margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
              aria-label={title}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 12 }}
                angle={-45}
                textAnchor="end"
                height={80}
                aria-label="Time axis"
              />
              <YAxis
                tick={{ fontSize: 12 }}
                label={{ value: 'Flux (particles/cm²·s·sr·MeV)', angle: -90, position: 'insideLeft' }}
                aria-label="Flux axis in particles per square centimeter per second per steradian per MeV"
              />
              <Tooltip
                formatter={(value: number) => [
                  value.toExponential(2),
                  'Flux (particles/cm²·s·sr·MeV)',
                ]}
                labelFormatter={(label) => `Time: ${label}`}
              />
              {showLegend && <Legend />}
              {timeSeries.map((series, index) => {
                const seriesKey = `${series.orbitType}-${series.particleType}`;
                return (
                  <Line
                    key={seriesKey}
                    type="monotone"
                    dataKey={seriesKey}
                    stroke={getLineColor(index)}
                    strokeWidth={2}
                    name={`${series.orbitType} ${series.particleType}`}
                    dot={false}
                    aria-label={`${series.orbitType} ${series.particleType} radiation flux over time`}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p id="chart-description" className="sr-only">
          {chartSummary}
        </p>
      </CardContent>
    </Card>
  );
}

