/**
 * Link stability as Argo measures it (tools/argo/linkstats.go): availability
 * over the last 24 h and 7 days from the device's own incident log. -1 means
 * not measured; it is shown as such, never as a number.
 */
export interface LinkWindow {
  observedSec: number;
  availability: number;
  outages: number;
  downSec: number;
  mttrP50Sec: number;
  mttrP95Sec: number;
  mtbfSec: number;
}

export interface LinkReport {
  d1: LinkWindow;
  d7: LinkWindow;
}

export type StabilityTone = 'good' | 'fair' | 'poor' | 'unknown';

/** 0-100 from the 7-day availability, or null when not measured. */
export function stabilityScore(link?: LinkReport): number | null {
  if (!link || link.d7.availability < 0) return null;
  return Math.round(link.d7.availability * 100);
}

/** ≥95 good, ≥80 fair, below that poor (the hostel hotspot week scored 83). */
export function stabilityTone(score: number | null): StabilityTone {
  if (score === null) return 'unknown';
  return score >= 95 ? 'good' : score >= 80 ? 'fair' : 'poor';
}

/** Same wording as `argo link`: 45 s, 3 min, 2.5 h, 1.5 days. */
export function humanSecs(s: number): string {
  if (s < 0) return 'n/a';
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

/** One line for a window, e.g. "84.3% up · 24 drops · typical outage 3 min (p95 63 min)". */
export function windowLine(w: LinkWindow): string {
  if (w.availability < 0) return 'not measured yet';
  const parts = [`${(w.availability * 100).toFixed(1)}% up`, `${w.outages} drop${w.outages === 1 ? '' : 's'}`];
  if (w.mttrP50Sec >= 0) parts.push(`typical outage ${humanSecs(w.mttrP50Sec)} (p95 ${humanSecs(w.mttrP95Sec)})`);
  return parts.join(' · ');
}

export function bytesLabel(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}
