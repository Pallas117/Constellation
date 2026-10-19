import type { InterpolatedData } from '@/hooks/useSpaceWeather';
import { StatusBadge } from '@/components/brand/StatusBadge';
import { bzStatus, feedState, FEED_LABEL, kpStatus, scaleStatus, speedStatus, type ReadoutStatus } from '@/lib/readout-status';

interface HUDProps {
  data: InterpolatedData;
}

/** One telemetry row. Only non-nominal values get a status word, so problems stand out. */
const DataRow = ({ label, value, unit, status }: { label: string; value: string; unit: string; status?: ReadoutStatus | null }) => (
  <div className="flex items-center justify-between gap-3 border-b border-charcoal py-1.5 last:border-b-0">
    <dt className="font-mono text-xs uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
    <dd className="flex items-center gap-2 font-mono tabular-nums">
      {status && status.tone !== 'nominal' && <StatusBadge tone={status.tone}>{status.word}</StatusBadge>}
      <span className="text-sm font-medium text-foreground">{value}</span>
      <span className="w-9 text-[11px] text-muted-foreground">{unit}</span>
    </dd>
  </div>
);

/**
 * Solar-wind telemetry for the operator console. Fails closed: with no
 * measurement every value is "—" (the hook's placeholder numbers never show).
 */
export const HUD = ({ data }: HUDProps) => {
  const feed = feedState(data);
  const measured = feed !== 'unavailable';
  const fixed = (n: number) => (measured ? n.toFixed(1) : '—');

  return (
    <section aria-labelledby="hud-title" className="hud-panel p-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 id="hud-title" className="brand-label">03_SOLAR_WIND</h2>
        {feed !== 'live' && <StatusBadge tone="caution">{FEED_LABEL[feed]}</StatusBadge>}
      </div>
      <dl>
        <DataRow
          label="Wind speed"
          value={measured ? String(Math.round(data.solarWind.speed)) : '—'}
          unit="km/s"
          status={measured ? speedStatus(data.solarWind.speed) : null}
        />
        <DataRow label="Density" value={fixed(data.solarWind.density)} unit="cm⁻³" />
        <DataRow
          label="IMF Bz"
          value={measured ? `${data.imfBz > 0 ? '+' : ''}${data.imfBz.toFixed(1)}` : '—'}
          unit="nT"
          status={measured ? bzStatus(data.imfBz) : null}
        />
        <DataRow label="Kp" value={fixed(data.kpIndex)} unit="/ 9" status={measured ? kpStatus(data.kpIndex) : null} />
        <DataRow
          label="Proton flux"
          value={measured && data.protonFlux != null ? data.protonFlux.toFixed(1) : '—'}
          unit="pfu"
          // The radiation stream (NOAA S-scale), separate from the geomagnetic Kp above.
          status={measured && data.radiation ? scaleStatus(data.radiation) : null}
        />
      </dl>
      <p className="mt-2 font-mono text-[11px] text-muted-foreground">
        {measured
          ? `Measured ${data.timestamp.toISOString().slice(11, 19)} UTC`
          : 'No measurement from any connected source'}
      </p>
    </section>
  );
};
