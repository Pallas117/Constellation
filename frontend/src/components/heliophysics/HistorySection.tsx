/**
 * The 24 h history under the heliophysics scene. Loaded on demand (its own chunk,
 * with the charting library) when someone scrolls toward it, so the 24 h backfill
 * and the chart's first render are never part of the page's boot.
 */
import { useEffect, useMemo, useState } from "react";
import { AuroraCastMap } from "@/components/heliophysics/AuroraCastMap";
import { SolarWindSpeedChart } from "@/components/heliophysics/SolarWindSpeedChart";
import { useAuroraMap } from "@/hooks/useAuroraMap";
import { apiBase } from "@/lib/api/base-url";
import { mergeSeries, SERIES_MAX_POINTS, SERIES_WINDOW_MS } from "@/lib/api/feed-series";
import type { CanonicalSpaceWeatherPoint } from "@/lib/types/space-weather";

/** One 24 h backfill of the 5 s feed (the `user`-role route; the page is behind sign-in). */
function useDayBackfill(): { points: CanonicalSpaceWeatherPoint[] | null; error: string | null } {
  const [points, setPoints] = useState<CanonicalSpaceWeatherPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const lookback = `PT${Math.round(SERIES_WINDOW_MS / 1000)}S`;
    fetch(`${apiBase()}/api/feed/space-weather/5s?lookback=${lookback}&limit=${SERIES_MAX_POINTS}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`History HTTP ${response.status}`);
        const json = (await response.json()) as { points?: CanonicalSpaceWeatherPoint[] };
        setPoints(mergeSeries(null, Array.isArray(json.points) ? json.points : []));
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "History unavailable");
      });
    return () => controller.abort();
  }, []);
  return { points, error };
}

export default function HistorySection({
  livePoints,
  source,
}: {
  /** The page's live feed: appended to the backfill as new points arrive. */
  livePoints: CanonicalSpaceWeatherPoint[];
  source: "polling" | "websocket";
}) {
  const backfill = useDayBackfill();
  const aurora = useAuroraMap();
  const points = useMemo(() => mergeSeries(backfill.points, livePoints), [backfill.points, livePoints]);

  return (
    <>
      <SolarWindSpeedChart points={points} loading={backfill.points === null && !backfill.error} error={backfill.error} source={source} />
      <AuroraCastMap map={aurora.map} loading={aurora.loading} error={aurora.error} />
    </>
  );
}
