import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { ReadoutStatus, Tone } from '@/lib/readout-status';
import { StatusBadge } from './StatusBadge';

/**
 * One telemetry number on a brand panel (Figma: "Readout"). Pass `status`
 * null when there is no measurement: the value should then be "—", and the
 * card says so instead of showing a plausible default.
 */
export function Readout({
  label,
  value,
  unit,
  status,
  meter,
  note,
  className,
}: {
  label: string;
  value: string;
  unit?: string;
  status: ReadoutStatus | null;
  meter?: ReactNode;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('hud-panel p-4', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
        {status ? (
          <StatusBadge tone={status.tone === 'nominal' ? 'neutral' : status.tone}>{status.word}</StatusBadge>
        ) : (
          <StatusBadge tone="caution">No data</StatusBadge>
        )}
      </div>
      <p className="mt-2 flex items-baseline gap-1.5 font-mono tabular-nums">
        <span className="text-3xl font-medium leading-9 text-foreground">{value}</span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </p>
      {status && meter}
      {note && <p className="mt-2 text-sm leading-snug text-muted-foreground">{note}</p>}
    </div>
  );
}

const METER_FILL: Record<Tone, string> = {
  nominal: 'bg-foreground/70',
  caution: 'bg-caution',
  risk: 'bg-sun',
};

/** Thin bar under a readout. `fraction` is clamped to 0–1. */
export function Meter({ fraction, tone, label }: { fraction: number; tone: Tone; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="mt-3 h-1 w-full overflow-hidden rounded-full bg-charcoal"
    >
      <div className={cn('h-full rounded-full', METER_FILL[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Kp as nine segments, filled to the measured level. */
export function KpMeter({ kp, tone }: { kp: number; tone: Tone }) {
  const filled = Math.round(Math.min(9, Math.max(0, kp)));
  return (
    <div role="meter" aria-label="Kp index" aria-valuemin={0} aria-valuemax={9} aria-valuenow={kp} className="mt-3 flex gap-1">
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={cn('h-1 flex-1 rounded-full', i < filled ? METER_FILL[tone] : 'bg-charcoal')} />
      ))}
    </div>
  );
}
