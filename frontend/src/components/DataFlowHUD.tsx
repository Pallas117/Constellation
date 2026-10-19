import type { FC, ReactNode } from 'react';
import { useConnectivity, type ConnectivityMode } from '@/hooks/useConnectivity';
import { usePipelineLatency } from '@/hooks/usePipelineLatency';
import type { PipelineTone } from '@/lib/pipelineLatency';
import { StatusBadge, type BadgeTone } from '@/components/brand/StatusBadge';

interface DataFlowHUDProps {
  tier?: number;
}

// Freshness tiers the backend emits: 0 live, 1 measured but ageing (10-15 min),
// 3 no measurement within 15 min. 2 is not emitted.
const TIER_LABEL = ['Live feed', 'Ageing measurement', 'Model', 'No recent measurement'];

const LINK_LABEL: Record<ConnectivityMode, string> = {
  CLOUD: 'Cloud',
  SAT: 'Satellite',
  AIRGAP: 'Air-gapped',
};

const PIPELINE_BADGE: Record<PipelineTone, BadgeTone | null> = {
  nominal: null,
  warn: 'caution',
  critical: 'risk',
  unknown: 'neutral',
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
  const pipeline = usePipelineLatency();
  const tierLabel = TIER_LABEL[tier] ?? 'Unknown';
  const pipelineBadge = PIPELINE_BADGE[pipeline.tone];

  return (
    <section aria-labelledby="dataflow-title" className="hud-panel p-3">
      <h2 id="dataflow-title" className="brand-label mb-1">05_DATA_PATH</h2>
      <dl>
        <Row label="Feed source">
          {tier >= 1 ? <StatusBadge tone={tier >= 3 ? 'risk' : 'caution'}>{tierLabel}</StatusBadge> : tierLabel}
        </Row>
        <Row label="Data age">{pipeline.dataAge}</Row>
        <Row label="Ingest tick">{pipeline.tick}</Row>
        <Row label="Slowest stage">{pipeline.slowest}</Row>
        <Row label="Pipeline">
          {pipelineBadge ? <StatusBadge tone={pipelineBadge}>{pipeline.label}</StatusBadge> : pipeline.label}
        </Row>
        <Row label="Link">
          {mode === 'AIRGAP' ? <StatusBadge tone="caution">{LINK_LABEL[mode]}</StatusBadge> : LINK_LABEL[mode]}
        </Row>
        <Row label="Latency">{latencyMs >= 0 ? `${latencyMs} ms` : '—'}</Row>
      </dl>
    </section>
  );
};
