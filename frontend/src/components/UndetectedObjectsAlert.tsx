/** @jsxRuntime automatic */
// Bare `node --import tsx --test` runs miss tsconfig.app.json's react-jsx; this keeps them working.

/**
 * UndetectedObjectsAlert — untracked spacecraft candidates for the operator
 * console's telemetry column. Shows only what the detection alert contains.
 */

import type { FC } from 'react';
import { AlertTriangle, Radar } from 'lucide-react';
import type { SpaceObjectDetectionAlert } from '@/lib/types/space-object';
import { StatusBadge, type BadgeTone } from '@/components/brand/StatusBadge';
import { ssaStatus } from '@/lib/ssaStatus';

interface UndetectedObjectsAlertProps {
  alert: SpaceObjectDetectionAlert | null;
}

const SEVERITY_TONE: Record<SpaceObjectDetectionAlert['severity'], BadgeTone> = {
  critical: 'risk',
  high: 'risk',
  moderate: 'caution',
  low: 'neutral',
};

export const UndetectedObjectsAlert: FC<UndetectedObjectsAlertProps> = ({ alert }) => {
  // No alert is not "nominal": with no detector connected, the SSA state is unknown (GAU-81).
  if (!alert) {
    return (
      <section aria-labelledby="ssa-title" className="hud-panel p-3">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 id="ssa-title" className="brand-label flex items-center gap-2">
            <Radar className="h-3.5 w-3.5" aria-hidden="true" />
            04_ORBITAL_OBJECTS
          </h2>
          <StatusBadge tone="neutral">Unknown</StatusBadge>
        </div>
        <p className="text-sm text-muted-foreground">{ssaStatus(alert).detail}</p>
      </section>
    );
  }

  const tone = SEVERITY_TONE[alert.severity];
  const orbits = [...new Set(alert.candidates.map((c) => c.orbitType).filter(Boolean))].join(' · ') || '—';

  return (
    <section
      aria-labelledby="ssa-title"
      role="alert"
      className={`hud-panel p-3 ${tone === 'risk' ? 'border-sun' : tone === 'caution' ? 'border-caution/60' : ''}`}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <h2 id="ssa-title" className="flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle className={`h-4 w-4 ${tone === 'risk' ? 'text-sun' : tone === 'caution' ? 'text-caution' : 'text-muted-foreground'}`} aria-hidden="true" />
          Untracked object alert
        </h2>
        <StatusBadge tone={tone} pulse={alert.severity === 'critical'}>
          {alert.severity}
        </StatusBadge>
      </div>

      <p className="text-sm leading-snug text-muted-foreground">{alert.description}</p>

      <dl className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-md border border-charcoal p-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Candidates</dt>
          <dd className="font-mono text-xl font-medium tabular-nums">{alert.candidateCount}</dd>
        </div>
        <div className="rounded-md border border-charcoal p-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted-foreground">Orbit</dt>
          <dd className="font-mono text-sm">{orbits}</dd>
        </div>
      </dl>

      {alert.candidates.length > 0 && (
        <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto">
          {alert.candidates.map((candidate, idx) => (
            <li key={`${candidate.id}-${idx}`} className="rounded-md border border-charcoal px-2 py-1.5 font-mono text-xs">
              <div className="flex justify-between gap-2">
                <span className="truncate text-foreground">{candidate.name}</span>
                <span className="shrink-0 text-muted-foreground">{candidate.id}</span>
              </div>
              <div className="flex justify-between gap-2 text-muted-foreground">
                <span>{candidate.category}</span>
                <span className="tabular-nums">{candidate.altitude.toLocaleString()} km</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 font-mono text-[11px] text-muted-foreground">
        Detected {new Date(alert.timestamp).toISOString().slice(11, 19)} UTC
      </p>
    </section>
  );
};
