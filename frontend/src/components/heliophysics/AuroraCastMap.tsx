import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AuroraMapResponse } from "@/lib/types/space-weather";

interface AuroraCastMapProps {
  map: AuroraMapResponse | null;
  loading: boolean;
  error: string | null;
}

function colorForProbability(probability: number): string {
  const p = Math.max(0, Math.min(1, probability));
  const hue = 190 - p * 150;
  const sat = 85;
  const light = 25 + p * 40;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

export function AuroraCastMap({ map, loading, error }: AuroraCastMapProps) {
  const sample = useMemo(() => {
    if (!map?.grid) return [];
    return map.grid.filter((_, idx) => idx % 20 === 0);
  }, [map]);

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Aurora Cast (GSM)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {loading && <p className="text-xs text-muted-foreground">Loading aurora map...</p>}

        <div className="relative h-[280px] w-full overflow-hidden rounded-md border bg-background">
          <svg viewBox="0 0 720 360" className="h-full w-full">
            <rect x="0" y="0" width="720" height="360" fill="hsl(var(--background))" />
            {sample.map((point, index) => {
              const x = ((point.lon + 180) / 360) * 720;
              const y = ((90 - point.lat) / 180) * 360;
              const size = 2 + point.probability * 4;
              return (
                <circle
                  key={`${point.lat}-${point.lon}-${index}`}
                  cx={x}
                  cy={y}
                  r={size}
                  fill={colorForProbability(point.probability)}
                  fillOpacity={0.65}
                />
              );
            })}
          </svg>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background to-transparent" />
        </div>

        {map && (
          <div className="text-xs text-muted-foreground">
            <p>
              Timestamp: <span className="font-mono">{new Date(map.timestamp).toLocaleString()}</span>
            </p>
            <p>
              NSIDE: <span className="font-mono">{map.nside}</span> | Harmonics lMax:{" "}
              <span className="font-mono">{map.harmonics.lMax}</span>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
