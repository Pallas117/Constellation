/**
 * ReasoningStream — knowledge-base assistant plus the ML storm forecast,
 * centred under the scene in the operator console. The forecast says
 * "unavailable" when no trained model is deployed.
 */

import { GaussRagPanel } from './GaussRagPanel';
import { useAnomalyForecast } from '@/hooks/useAnomalyForecast';
import { StatusBadge, type BadgeTone } from '@/components/brand/StatusBadge';

// Every state is the loaded banner's height (3 lines): the column is anchored at the bottom of the
// scene, so a banner that grew on arrival pushed the assistant above it up the screen.
const BANNER = 'hud-panel min-h-[5rem] px-3 py-2';

function ForecastBanner() {
  const { forecast, loading, error } = useAnomalyForecast();

  if (loading && !forecast) {
    // 250 ms rule: show that the model is working rather than an empty slot.
    return (
      <div data-testid="forecast-banner" className={`${BANNER} flex items-center gap-2 font-mono text-xs text-muted-foreground`}>
        <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
        Storm forecast: computing…
      </div>
    );
  }

  // No trained model (or no answer): say so. Never show a probability we do not have.
  if (!forecast || !('anomalyProbability' in forecast)) {
    const reason = forecast && 'reason' in forecast ? forecast.reason : error ?? 'No forecast';
    return (
      <div data-testid="forecast-banner" className={`${BANNER} flex items-center gap-2 font-mono text-xs text-muted-foreground`} title={reason}>
        <StatusBadge tone="neutral">Unavailable</StatusBadge>
        <span className="truncate">{reason}</span>
      </div>
    );
  }

  // Severity follows the storm probability: it has held-out skill, while the Kp estimate trails
  // persistence during storms (see the model's gate warnings).
  const p = forecast.anomalyProbability;
  const tone: BadgeTone = p >= 0.5 ? 'risk' : p >= 0.2 ? 'caution' : 'neutral';
  const word = p >= 0.5 ? 'Storm likely' : p >= 0.2 ? 'Elevated' : 'Quiet';

  return (
    <div data-testid="forecast-banner" className={BANNER} title={forecast.warningMessage}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs tabular-nums text-foreground">
          {forecast.horizonHours} h forecast · P(G1+) {(p * 100).toFixed(1)}% · Kp max ≈ {forecast.predictedKpMax.toFixed(1)}
        </p>
        <StatusBadge tone={tone}>{word}</StatusBadge>
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">{forecast.warningMessage}</p>
      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
        CI {(forecast.confidenceInterval[0] * 100).toFixed(0)}–{(forecast.confidenceInterval[1] * 100).toFixed(0)}% · model{' '}
        {forecast.modelVersion}
      </p>
    </div>
  );
}

export function ReasoningStream() {
  return (
    <div className="flex w-full max-w-xl flex-col gap-2">
      <GaussRagPanel />
      <ForecastBanner />
      <p className="text-center font-mono text-[11px] text-muted-foreground">
        Sources: NOAA SWPC real-time solar wind (L1) · ML storm forecast
      </p>
    </div>
  );
}
