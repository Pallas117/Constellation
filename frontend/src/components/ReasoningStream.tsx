/**
 * ReasoningStream — LLM / RAG inference panel + 72-hour ML forecast widget.
 *
 * Self-contained; wraps GaussRagPanel and
 * the LSTM anomaly-probability banner. Bottom centre from md up; in the phone column below.
 */

import { GaussRagPanel } from './GaussRagPanel';
import { useAnomalyForecast, type AnomalyForecast } from '@/hooks/useAnomalyForecast';
import { AlertTriangle, Activity, CircleSlash, ShieldCheck } from 'lucide-react';


function ForecastBanner({ forecast, loading, error }: { forecast: AnomalyForecast | null; loading: boolean; error: string | null }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-black/50 border border-border text-[8px] font-mono text-muted-foreground uppercase tracking-widest">
        <Activity size={8} className="animate-pulse" />
        LSTM_FORECAST: COMPUTING...
      </div>
    );
  }

  // No forecast (no model configured, signed out, or the request failed): say so
  // rather than keep "computing" or show a number nothing produced.
  if (!forecast) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 px-3 py-1.5 bg-black/50 border border-border text-[8px] font-mono text-muted-foreground uppercase tracking-widest"
      >
        <CircleSlash size={8} className="shrink-0" />
        <span>LSTM_FORECAST: UNAVAILABLE</span>
        {error && <span className="normal-case tracking-normal opacity-70">{error}</span>}
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
          72H_LSTM_FORECAST &nbsp;|&nbsp; P(anomaly) = {pct}% &nbsp;|&nbsp; Kp_max ≈ {kpMax}
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
  const { forecast, loading, error } = useAnomalyForecast();

  return (
    <div
      className="pointer-events-none flex flex-col items-center gap-1.5 [contain:layout_style] md:absolute md:bottom-6 md:left-1/2 md:-translate-x-1/2"
    >
      <div className="pointer-events-auto">
        <GaussRagPanel />
      </div>

      <div className="pointer-events-auto w-full">
        <ForecastBanner forecast={forecast} loading={loading} error={error} />
      </div>

      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
        Sources: NOAA SWPC real-time solar wind (L1){forecast && ' · 72 h LSTM forecast'}
      </p>
    </div>
  );
}
