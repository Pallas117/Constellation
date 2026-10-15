/**
 * Keeps the traced magnetosphere stable under noisy live data.
 *
 * - DriverAverager: time-weighted running mean of the solar-wind drivers over
 *   a trailing window (default 5 min). Empirical boundary models such as
 *   Shue (1998) are fitted to averaged upstream conditions, so averaging is
 *   the physically appropriate input for the geometry, not just cosmetic.
 *   Readouts elsewhere still show the latest measured values.
 * - shouldRetrace: hysteresis, so the field lines are only re-traced when the
 *   averaged drivers move by a meaningful amount, not on every jitter.
 * - damp: frame-rate independent exponential approach used to morph geometry.
 */
import type { SolarWindDrivers } from './geomagnetic';

const KEYS = ['bz', 'by', 'pdyn', 'kp'] as const;

const finite = (d: SolarWindDrivers) => KEYS.every((k) => Number.isFinite(d[k]));

export class DriverAverager {
  private samples: { t: number; d: SolarWindDrivers }[] = [];

  constructor(private readonly windowMs = 5 * 60_000) {}

  /** Record the drivers in effect from time t (ms). Non-finite values are ignored. */
  push(t: number, d: SolarWindDrivers): void {
    if (!finite(d)) return;
    const last = this.samples[this.samples.length - 1];
    if (last && t <= last.t) {
      // Same instant (or clock went backwards): the newer value wins.
      last.d = { ...d };
      return;
    }
    this.samples.push({ t, d: { ...d } });
    this.prune(t);
  }

  /** Time-weighted mean over [now - window, now]; null before any sample. */
  mean(now: number): SolarWindDrivers | null {
    this.prune(now);
    if (this.samples.length === 0) return null;
    const start = now - this.windowMs;
    const acc = { bz: 0, by: 0, pdyn: 0, kp: 0 };
    let total = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const from = Math.max(this.samples[i].t, start);
      const to = i + 1 < this.samples.length ? this.samples[i + 1].t : now;
      // The latest sample always counts a little, so a brand-new value isn't ignored.
      const w = Math.max(to - from, i + 1 === this.samples.length ? 1 : 0);
      if (w <= 0) continue;
      for (const k of KEYS) acc[k] += this.samples[i].d[k] * w;
      total += w;
    }
    if (total <= 0) return { ...this.samples[this.samples.length - 1].d };
    return { bz: acc.bz / total, by: acc.by / total, pdyn: acc.pdyn / total, kp: acc.kp / total };
  }

  /** Forget history (e.g. switching between live and simulated drivers). */
  reset(): void {
    this.samples = [];
  }

  private prune(now: number): void {
    const start = now - this.windowMs;
    // Keep the last sample that started before the window: it is still in effect at `start`.
    let firstInWindow = this.samples.findIndex((s) => s.t >= start);
    if (firstInWindow === -1) firstInWindow = this.samples.length;
    const keepFrom = Math.max(0, firstInWindow - 1);
    if (keepFrom > 0) this.samples.splice(0, keepFrom);
  }
}

export interface RetraceThresholds {
  /** nT */
  bz: number;
  /** nT */
  by: number;
  /** fraction of the previous Pdyn */
  pdynFraction: number;
  /** nPa, floor for low pressure */
  pdynMin: number;
  kp: number;
}

/**
 * Changes below these are visually and physically insignificant for the model:
 * 0.75 nT in Bz moves the Shue standoff by < 0.1 Re around nominal conditions.
 */
export const DEFAULT_RETRACE: RetraceThresholds = { bz: 0.75, by: 1, pdynFraction: 0.08, pdynMin: 0.15, kp: 0.5 };

export function shouldRetrace(
  previous: SolarWindDrivers | null,
  next: SolarWindDrivers,
  th: RetraceThresholds = DEFAULT_RETRACE,
): boolean {
  if (!previous) return true;
  return (
    Math.abs(next.bz - previous.bz) >= th.bz ||
    Math.abs(next.by - previous.by) >= th.by ||
    Math.abs(next.pdyn - previous.pdyn) >= Math.max(th.pdynMin, th.pdynFraction * Math.abs(previous.pdyn)) ||
    Math.abs(next.kp - previous.kp) >= th.kp
  );
}

/** Move `current` toward `target` with time constant `tauS` (seconds); tau 0 snaps. */
export function damp(current: number, target: number, dtS: number, tauS: number): number {
  if (tauS <= 0 || !Number.isFinite(current)) return target;
  return target + (current - target) * Math.exp(-Math.max(0, dtS) / tauS);
}
