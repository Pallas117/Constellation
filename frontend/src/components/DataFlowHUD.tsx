import type { FC, ReactNode } from 'react';
import { useConnectivity, type ConnectivityMode } from '@/hooks/useConnectivity';
import { StatusBadge } from '@/components/brand/StatusBadge';

interface DataFlowHUDProps {
  tier?: number;
}

// Ingest tiers from useSpaceWeather: 0 live, 1 redundant buffer, 2 model, 3 stale.
const TIER_LABEL = ['Live feed', 'Redundant buffer', 'Model (simulated)', 'Stale'];

const LINK_LABEL: Record<ConnectivityMode, string> = {
  CLOUD: 'Cloud',
  SAT: 'Satellite',
  AIRGAP: 'Air-gapped',
};

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-center justify-between gap-3 border-b border-charcoal py-1.5 last:border-b-0">
    <dt className="font-mono text-xs uppercase tracking-[0.06em] text-muted-foreground">{label}</dt>
    <dd className="font-mono text-sm tabular-nums text-foreground">{children}</dd>
  </div>
);

/** Where the console's numbers come from right now. Only measured values; nothing decorative. */
export const DataFlowHUD: FC<DataFlowHUDProps> = ({ tier = 0 }) => {
  const { mode, latencyMs } = useConnectivity();
  const tierLabel = TIER_LABEL[tier] ?? 'Unknown';

  return (
    <section aria-labelledby="dataflow-title" className="hud-panel p-3">
      <h2 id="dataflow-title" className="brand-label mb-1">05_DATA_PATH</h2>
      <dl>
        <Row label="Feed source">
          {tier >= 2 ? <StatusBadge tone="caution">{tierLabel}</StatusBadge> : tierLabel}
        </Row>
        <Row label="Link">
          {mode === 'AIRGAP' ? <StatusBadge tone="caution">{LINK_LABEL[mode]}</StatusBadge> : LINK_LABEL[mode]}
        </Row>
        <Row label="Latency">{latencyMs >= 0 ? `${latencyMs} ms` : '—'}</Row>
      </dl>
    </section>
  );
};
