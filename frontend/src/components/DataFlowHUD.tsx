import { useConnectivity } from '@/hooks/useConnectivity';

interface DataFlowHUDProps {
  tier?: number;
}

/** How the feed is being served, by ingest tier (backend/worker/ingest-loop). */
const TIERS = ['Live from L1', 'Redundant buffer', 'Model estimate', 'Stale: last good values'];

const Row = ({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'caution' | 'muted' }) => (
  <div className="flex items-baseline justify-between gap-6 border-b border-border py-1.5 last:border-0">
    <dt className="stat-label">{label}</dt>
    <dd
      className={`font-mono text-xs tabular-nums ${
        tone === 'caution' ? 'text-caution' : tone === 'muted' ? 'text-muted-foreground' : 'text-foreground'
      }`}
    >
      {value}
    </dd>
  </div>
);

/** Where the console's data is coming from right now. Only measured values. */
export const DataFlowHUD = ({ tier = 0 }: DataFlowHUDProps) => {
  const { mode, latencyMs } = useConnectivity();

  return (
    // Phones (in the column) and wide screens; between, the bottom edge is the query panel's.
    <div className="block md:hidden xl:block">
      <section aria-label="Data flow" className="hud-panel pointer-events-auto min-w-[260px] bg-panel/85 p-3 backdrop-blur-md">
        <p className="brand-label mb-2">03_DATA_FLOW</p>
        <dl>
          <Row label="Feed" value={TIERS[tier] ?? 'Unknown'} tone={tier >= 2 ? 'caution' : 'normal'} />
          <Row label="Link" value={mode === 'AIRGAP' ? 'Offline (air-gapped)' : mode === 'SAT' ? 'Satellite' : 'Cloud'} tone={mode === 'AIRGAP' ? 'caution' : 'normal'} />
          <Row label="Latency" value={latencyMs >= 0 ? `${latencyMs} ms` : '—'} tone="muted" />
        </dl>
      </section>
    </div>
  );
};
