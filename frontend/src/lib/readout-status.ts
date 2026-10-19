/**
 * Status words and tones for the solar-wind readouts, shared by the landing
 * page and the operator HUD so both say the same thing about the same number.
 *
 * Tones follow the Lightbound Brand Room: nominal needs no attention, caution
 * is amber, risk is Sun. Words always accompany the tone (never colour alone).
 */

import type { ScaleReading, SenseCheck } from './types/space-weather';

export type Tone = 'nominal' | 'caution' | 'risk';

export interface ReadoutStatus {
  tone: Tone;
  word: string;
}

/** Solar wind bulk speed in km/s. Slow wind is typically 300–450 km/s. */
export function speedStatus(kms: number): ReadoutStatus {
  if (kms >= 600) return { tone: 'risk', word: 'High' };
  if (kms >= 450) return { tone: 'caution', word: 'Elevated' };
  return { tone: 'nominal', word: 'Normal' };
}

/** IMF Bz (GSM) in nT. Sustained southward Bz drives dayside reconnection. */
export function bzStatus(nt: number): ReadoutStatus {
  if (nt <= -10) return { tone: 'risk', word: 'Strongly south' };
  if (nt <= -5) return { tone: 'caution', word: 'Southward' };
  return { tone: 'nominal', word: nt < 0 ? 'Weakly south' : 'Northward' };
}

/**
 * Planetary Kp index. NOAA G-scale: Kp 5 = G1 … Kp 9 = G5; Kp 4 is "active".
 * Fractional Kp (e.g. 4.67 for "5−") is floored so a storm is only named at
 * the whole-number threshold.
 */
export function kpStatus(kp: number): ReadoutStatus {
  const level = Math.floor(kp);
  if (level >= 7) return { tone: 'risk', word: `G${Math.min(level - 4, 5)} storm` };
  if (level >= 5) return { tone: 'caution', word: `G${level - 4} storm` };
  if (level >= 4) return { tone: 'caution', word: 'Active' };
  return { tone: 'nominal', word: 'Quiet' };
}

/**
 * A NOAA storm-scale level (S for radiation, G for geomagnetic). Unknown is said
 * as unknown, never "none"; level 3 and above is risk (GAU-135).
 */
export function scaleStatus(reading: ScaleReading | null | undefined): ReadoutStatus {
  if (!reading || reading.level == null) return { tone: 'caution', word: 'Unknown' };
  if (reading.level === 0) return { tone: 'nominal', word: 'None' };
  // NOAA names R-scale events radio blackouts; S and G are storms.
  const kind = reading.label.startsWith('R') ? 'blackout' : 'storm';
  return { tone: reading.level >= 3 ? 'risk' : 'caution', word: `${reading.label} ${kind}` };
}

/** What each input sense-check (GAU-136) looks at, for its readout label. */
export const CHECK_LABEL: Record<SenseCheck['id'], string> = {
  'l1-field-magnitude': 'L1 field magnitude',
  'goes-proton-spectrum': 'Proton spectrum',
  'goes-proton-channels': 'Proton channels',
  'goes-xray': 'X-ray channel',
  'noaa-scales': 'NOAA scales',
};

/** A sense-check as a readout: nothing to check reads Unknown, never OK. */
export function checkStatus(check: SenseCheck | null | undefined): ReadoutStatus {
  if (!check || check.status === 'unknown') return { tone: 'caution', word: 'Unknown' };
  if (check.status === 'pass') return { tone: 'nominal', word: 'OK' };
  return { tone: 'caution', word: 'Flagged' };
}

/** The HUD components' tone for a readout status ("nominal" draws as the default). */
export function hudTone(tone: Tone): 'default' | 'caution' | 'risk' {
  return tone === 'nominal' ? 'default' : tone;
}

export type FeedState = 'live' | 'stale' | 'simulated' | 'unavailable';

/** Whole-feed state from the hook's provenance fields (tier 2 = synthetic). */
export function feedState(data: { source: string; isStale: boolean; tier: number }): FeedState {
  if (data.source === 'unavailable') return 'unavailable';
  if (data.tier === 2) return 'simulated';
  if (data.isStale) return 'stale';
  return 'live';
}

export const FEED_LABEL: Record<FeedState, string> = {
  live: 'Live',
  stale: 'Stale',
  simulated: 'Simulated',
  unavailable: 'No data',
};
