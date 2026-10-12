import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { memo, useDeferredValue, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CanonicalSpaceWeatherPoint } from "@/lib/types/space-weather";
import { bucketMeans } from "@/lib/api/feed-series";

/** Points drawn for 24 h: recharts re-lays-out every point on each update. */
const MAX_CHART_POINTS = 720;

interface SolarWindSpeedChartProps {
  points: CanonicalSpaceWeatherPoint[];
  loading: boolean;
  error: string | null;
  source: "polling" | "websocket";
}

function formatTick(ts: string): string {
  const date = new Date(ts);
  return `${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

export const SolarWindSpeedChart = memo(function SolarWindSpeedChart({
  points,
  loading,
  error,
  source,
}: SolarWindSpeedChartProps) {
  // Low priority: a new point never delays a frame of the 3D scene.
  const deferred = useDeferredValue(points);
  const { chartData, bucketMin } = useMemo(() => {
    const { buckets, bucketMs } = bucketMeans(
      deferred,
      (p) => ({ speed: p.solarWind.speed, density: p.solarWind.density }),
      MAX_CHART_POINTS,
    );
    return {
      chartData: buckets.map((b) => ({ timestamp: b.timestamp, ...b.values })),
      bucketMin: Math.round(bucketMs / 60_000),
    };
  }, [deferred]);

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">Solar wind speed and density</CardTitle>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {bucketMin}-min means · {source}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {loading && <p className="text-xs text-muted-foreground">Loading feed...</p>}
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatTick}
                minTickGap={30}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                yAxisId="speed"
                orientation="left"
                unit=" km/s"
                domain={[200, 2000]}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                yAxisId="density"
                orientation="right"
                unit=" p/cm3"
                domain={[0, 50]}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                labelFormatter={(label) => new Date(label).toLocaleString()}
                formatter={(value: number, name: string) => {
                  if (name === "speed") return [`${value.toFixed(1)} km/s`, "Solar wind speed"];
                  if (name === "density") return [`${value.toFixed(2)} p/cm3`, "Density"];
                  return [`${value.toFixed(2)} nT`, "IMF Bz"];
                }}
              />
              <Line
                yAxisId="speed"
                type="monotone"
                dataKey="speed"
                stroke="hsl(var(--foreground))"
                dot={false}
                strokeWidth={2}
                isAnimationActive={false}
              />
              <Line
                yAxisId="density"
                type="monotone"
                dataKey="density"
                stroke="hsl(var(--earth))"
                dot={false}
                strokeWidth={1.8}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
});
