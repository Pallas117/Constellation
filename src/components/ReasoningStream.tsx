/**
 * ReasoningStream — LLM / RAG inference panel + 72-hour ML forecast widget.
 *
 * Self-contained; wraps GaussRagPanel with bottom-centre positioning and
 * the LSTM anomaly-probability banner. GPU-isolated via will-change.
 */

import { GaussRagPanel } from './GaussRagPanel';
import { useAnomalyForecast } from '@/hooks/useAnomalyForecast';
import { AlertTriangle, Activity, ShieldCheck } from 'lucide-react';

const containerStyle: React.CSSProperties = {
  willChange: 'transform',
  transform: 'translate3d(-50%, 0, 0)',
  contain: 'layout style',
};

function ForecastBanner() {
  const { forecast, loading } = useAnomalyForecast();

  if (loading || !forecast) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-black/50 border border-primary/10 text-[8px] font-mono text-primary/30 uppercase tracking-widest">
        <Activity size={8} className="animate-pulse" />
        LSTM_FORECAST: COMPUTING...
      </div>
    );
  }

  const pct = (forecast.anomalyProbability * 100).toFixed(1);
  const kpMax = forecast.predictedKpMax.toFixed(1);
  const isHighRisk = forecast.predictedKpMax >= 5;
  const isSevere = forecast.predictedKpMax >= 7;

  const colour = isSevere
    ? 'border-red-500/60 text-red-400'
    : isHighRisk
    ? 'border-yellow-500/50 text-yellow-400'
    : 'border-primary/20 text-primary/60';

  const Icon = isSevere ? AlertTriangle : isHighRisk ? AlertTriangle : ShieldCheck;

  return (
    <div
      className={`flex items-start gap-2 px-3 py-2 bg-black/60 border backdrop-blur-sm ${colour}`}
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
  return (
    <div
      className="absolute bottom-6 left-1/2 flex flex-col items-center gap-1.5 pointer-events-none"
      style={containerStyle}
    >
      <div className="pointer-events-auto">
        <GaussRagPanel />
      </div>

      <div className="pointer-events-auto w-full">
        <ForecastBanner />
      </div>

      <p className="text-[8px] text-primary/30 font-bold uppercase tracking-[0.4em]">
        FEED_SRC: NOAA_SWPC // NASA_DSCOVR // LSTM_72H
      </p>
    </div>
  );
}
