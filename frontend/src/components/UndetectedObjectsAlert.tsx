/**
 * UndetectedObjectsAlert — Dramatic alert panel for untracked spacecraft candidates
 * Shows on the right side of the HUD with real-time detection updates
 */

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Radar, TrendingUp, Radio } from 'lucide-react';
import type { SpaceObjectDetectionAlert } from '@/lib/types/space-object';

interface UndetectedObjectsAlertProps {
  alert: SpaceObjectDetectionAlert | null;
  isOperator?: boolean;
}

export const UndetectedObjectsAlert: React.FC<UndetectedObjectsAlertProps> = ({
  alert,
  isOperator = false,
}) => {
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (!alert) return;
    const interval = setInterval(() => {
      setPulse((p) => !p);
    }, 800);
    return () => clearInterval(interval);
  }, [alert]);

  if (!alert) {
    return (
      <div className="pointer-events-auto">
        <div className="hud-panel p-3 min-w-[300px] border-border bg-panel/85">
          <div className="flex items-center gap-2 mb-2">
            <Radar className="w-4 h-4 text-muted-foreground" />
            <h3 className="text-[10px] font-bold tracking-[0.2em] uppercase">
              SSA_NOMINAL
            </h3>
          </div>
          <div className="text-[9px] text-muted-foreground">
            All known orbital assets accounted for. No anomalies detected.
          </div>
        </div>
      </div>
    );
  }

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'text-sun';
      case 'high':
        return 'text-sun';
      case 'moderate':
        return 'text-caution';
      default:
        return 'text-earth';
    }
  };

  const getSeverityBorder = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'border-destructive/50 bg-destructive/5';
      case 'high':
        return 'border-sun/50 bg-sun/5';
      case 'moderate':
        return 'border-caution/50 bg-caution/5';
      default:
        return 'border-earth/50 bg-earth/5';
    }
  };

  return (
    <div className="pointer-events-auto">
      <div
        className={`hud-panel p-4 min-w-[320px] border-2 ${getSeverityBorder(
          alert.severity
        )} transition-all duration-300 ${
          pulse ? 'shadow-lg shadow-destructive/30' : 'shadow-md'
        }`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between mb-4 pb-3 border-b ${getSeverityBorder(alert.severity)}`}>
          <div className="flex items-center gap-2">
            <AlertTriangle
              className={`w-5 h-5 ${getSeverityColor(alert.severity)} ${
                pulse ? 'scale-110' : 'scale-100'
              } transition-transform`}
            />
            <div>
              <h3
                className={`text-[11px] font-bold tracking-[0.3em] uppercase ${getSeverityColor(
                  alert.severity
                )}`}
              >
                UNTRACKED OBJECT ALERT
              </h3>
              <p className="text-[8px] text-muted-foreground uppercase tracking-widest">
                {alert.severity.toUpperCase()} PRIORITY
              </p>
            </div>
          </div>
          <div className="text-[8px] text-muted-foreground font-mono">
            {new Date(alert.timestamp).toLocaleTimeString()}
          </div>
        </div>

        {/* Alert Description */}
        <div className="mb-4 p-3 bg-background/60 border border-border rounded">
          <p className="text-[9px] leading-relaxed text-foreground">{alert.description}</p>
        </div>

        {/* Candidate Count */}
        <div className="mb-4 grid grid-cols-3 gap-2">
          <div className="p-2 bg-primary/5 border border-border rounded text-center">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Candidates</div>
            <div className={`text-xl font-bold ${getSeverityColor(alert.severity)}`}>
              {alert.candidateCount}
            </div>
          </div>
          <div className="p-2 bg-primary/5 border border-border rounded text-center">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Orbit</div>
            <div className="text-[10px] font-mono text-primary">GEO</div>
          </div>
          <div className="p-2 bg-primary/5 border border-border rounded text-center">
            <div className="text-[9px] text-muted-foreground uppercase tracking-wider">Status</div>
            <div className={`text-[10px] font-bold ${getSeverityColor(alert.severity)}`}>
              ACTIVE
            </div>
          </div>
        </div>

        {/* Candidate List */}
        <div className="mb-3">
          <div className="text-[8px] uppercase tracking-[0.2em] text-muted-foreground mb-2 flex items-center gap-1">
            <Radio className="w-3 h-3" />
            Detected Candidates
          </div>
          <div className="space-y-1">
            {alert.candidates.map((candidate, idx) => (
              <div
                key={`${candidate.id}-${idx}`}
                className="p-2 bg-background/60 border border-border rounded text-[8px] font-mono"
              >
                <div className="flex justify-between items-start mb-1">
                  <span className="text-primary">{candidate.name}</span>
                  <span className="text-[7px] text-muted-foreground">{candidate.id}</span>
                </div>
                <div className="flex justify-between text-muted-foreground text-[7px]">
                  <span>{candidate.category}</span>
                  <span>{candidate.altitude.toLocaleString()} km</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Operator Notice */}
        {isOperator && (
          <div className="rounded border border-caution/30 bg-caution/10 p-2 text-[10px] uppercase tracking-wider text-caution">
            ⚠ OPERATOR ALERT ENABLED · SECURITY PROTOCOLS ACTIVE · AUDIT TRAIL RECORDING
          </div>
        )}

        {/* Trend */}
        <div className="mt-3 flex items-center gap-2 text-[9px] text-muted-foreground">
          <TrendingUp className="w-3 h-3" />
          <span>Detection confidence increasing with radiation flux correlation</span>
        </div>

      </div>
    </div>
  );
};
