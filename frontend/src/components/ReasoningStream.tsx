/**
 * ReasoningStream — LLM / RAG inference panel + 72-hour ML forecast widget.
 *
 * Self-contained; wraps GaussRagPanel and the 72-hour anomaly-probability banner
 * (or "unavailable" when no trained model is deployed). Bottom centre from md up; in the phone column below.
 */

import { GaussRagPanel } from './GaussRagPanel';
import { useAnomalyForecast } from '@/hooks/useAnomalyForecast';
import { AlertTriangle, Activity, ShieldCheck } from 'lucide-react';


function ForecastBanner() {
  const { forecast, loading, error } = useAnomalyForecast();

  if (loading && !forecast) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-black/50 border border-border text-[8px] font-mono text-muted-foreground uppercase tracking-widest">
        <Activity size={8} className="animate-pulse" />
        72H_FORECAST: AWAITING_NODE
      </div>
    );
  }

  // No trained model (or no answer): say so. Never show a probability we do not have.
  if (!forecast || !('anomalyProbability' in forecast)) {
    const reason = forecast && 'reason' in forecast ? forecast.reason : error ?? 'No forecast';
    return (
      <div
        role="status"
        className="flex items-center gap-2 px-3 py-1.5 bg-black/50 border border-border text-[8px] font-mono text-muted-foreground uppercase tracking-widest"
        title={reason}
      >
        <Activity size={8} />
        72H_FORECAST: UNAVAILABLE &nbsp;|&nbsp; {reason}
      </div>
    );
  }

  const pct = (forecast.anomalyProbability * 100).toFixed(1);
  const kpMax = forecast.predictedKpMax.toFixed(1);
  const isHighRisk = forecast.predictedKpMax >= 5;
  const isSevere = forecast.predictedKpMax >= 7;

  const colour = isSevere
    ? 'border-sun/60 text-sun'
    : isHighRisk
    ? 'border-caution/50 text-caution'
    : 'border-border text-muted-foreground';

  const Icon = isSevere ? AlertTriangle : isHighRisk ? AlertTriangle : ShieldCheck;

  return (
    <div
      className={`flex items-start gap-2 px-3 py-2 bg-panel/85 border backdrop-blur-sm ${colour}`}
      title={forecast.warningMessage}
    >
      <Icon size={10} className="mt-0.5 shrink-0" />
      <div className="space-y-0.5 text-left">
        <p className="text-[9px] font-bold uppercase tracking-wider">
          72H_FORECAST &nbsp;|&nbsp; P(anomaly) = {pct}% &nbsp;|&nbsp; Kp_max ≈ {kpMax}
        </p>
        <p className="text-[8px] opacity-70 font-mono truncate max-w-[440px]">
          {forecast.warningMessage}
        </p>
        <p className="text-[7px] opacity-40 font-mono">
          CI: [{(forecast.confidenceInterval[0] * 100).toFixed(0)}%,
          {(forecast.confidenceInterval[1] * 100).toFixed(0)}%]
          &nbsp; MDL: {forecast.modelVersion}
        </p>
      </div>
    </div>
  );
}

export function ReasoningStream() {
  return (
    <div
      className="pointer-events-none flex flex-col items-center gap-1.5 [contain:layout_style] md:absolute md:bottom-6 md:left-1/2 md:-translate-x-1/2"
    >
      <div className="pointer-events-auto">
        <GaussRagPanel />
      </div>

      <div className="pointer-events-auto w-full">
        <ForecastBanner />
      </div>

      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
        Sources: NOAA SWPC real-time solar wind (L1)
      </p>
    </div>
  );
}
