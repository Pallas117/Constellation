/**
 * Device status cards on the /mesh page: what one device's last Argo report says about
 * its power and security, as words and tones. Free of React so it is unit-tested.
 *
 * Fail closed: a field the report does not carry reads "—" with "Not reported", never a
 * default. Tones follow lib/readout-status.ts (nominal draws neutral, a word always
 * accompanies the tone).
 */

import {
  deviceStage,
  POSTURE_LABEL,
  type BatteryReading,
  type DeviceStage,
  type OnboardingDevice,
  type PostureReading,
  type PostureStatus,
} from './mesh-onboarding.ts';
import type { ReadoutStatus } from './readout-status.ts';

export const PLATFORM_LABEL: Record<string, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows', ios: 'iPhone', android: 'Android' };

// Mirrors hostingVerdict in backend/mesh/store.ts.
export const HOSTING_LABEL: Record<string, string> = {
  agents: 'Agents + memory',
  light: 'Light work',
  no: 'No spare capacity',
  unknown: 'Unknown',
};

/** On battery at or below this: Argo's guard stops work at the 10% floor (backend/mesh/store.ts "battery-floor"). */
export const BATTERY_CRITICAL_PCT = 10;
/** On battery at or below this the hub stops offering the device work (assessHosting in backend/mesh/store.ts). */
export const BATTERY_LOW_PCT = 20;

/** "just now", "4 min ago", "3 h ago", "2 d ago"; "—" when there is no usable time. A time ahead of the clock reads "just now". */
export function ageLabel(iso: string | undefined, now: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const STAGE_STATUS: Record<DeviceStage, ReadoutStatus> = {
  reporting: { tone: 'nominal', word: 'Reporting' },
  stale: { tone: 'caution', word: 'Stale' },
  waiting: { tone: 'caution', word: 'Waiting' },
  silent: { tone: 'caution', word: 'No report' },
  rejected: { tone: 'risk', word: 'Refused' },
};

/** Whether the device is reporting, with the age of its last report. */
export function seenStatus(d: OnboardingDevice, now: number): { stage: DeviceStage; status: ReadoutStatus; age: string } {
  const stage = deviceStage(d, now);
  return { stage, status: STAGE_STATUS[stage], age: ageLabel(d.last?.receivedAt, now) };
}

/** What the device is: its platform and what it offers the mesh. Phones only report status. */
export function deviceRole(d: { hosting?: string; last?: { platform?: string } }): string {
  const platform = d.last?.platform;
  if (!platform) return d.last ? 'Platform not reported' : 'No report yet';
  const offers = platform === 'ios' || platform === 'android' ? 'Status only' : (HOSTING_LABEL[d.hosting ?? 'unknown'] ?? HOSTING_LABEL.unknown);
  return `${PLATFORM_LABEL[platform] ?? platform} · ${offers}`;
}

export interface CardReading {
  /** The number as text, or "—" when the report carries none. */
  value: string;
  unit?: string;
  status: ReadoutStatus;
  /** Supporting facts from the report, most important first. */
  detail: string[];
}

export interface BatteryCardReading extends CardReading {
  /** 0–1 for the meter; null when there is no level to draw. */
  fraction: number | null;
}

const NOT_REPORTED: ReadoutStatus = { tone: 'nominal', word: 'Not reported' };

/**
 * Battery percent with its power state. Argo says whether it is on mains (`external`) and what the
 * charger negotiated; phones only say whether they charge, so "not charging" is read as on battery,
 * as the hub does (assessHosting).
 */
export function batteryStatus(b: BatteryReading | undefined): BatteryCardReading {
  if (!b || !Number.isFinite(b.level)) return { value: '—', status: NOT_REPORTED, detail: [], fraction: null };

  const level = Math.round(b.level);
  const onBattery = (b.external ?? b.charging) === false;
  const charger = b.charger;
  const weakCharger = !onBattery && (charger?.state === 'no-pd' || charger?.state === 'pd-low' || b.power?.mode === 'negative');

  let status: ReadoutStatus;
  if (onBattery && level <= BATTERY_CRITICAL_PCT) status = { tone: 'risk', word: 'Critical · on battery' };
  else if (onBattery && level <= BATTERY_LOW_PCT) status = { tone: 'caution', word: 'Low · on battery' };
  else if (onBattery) status = { tone: 'nominal', word: 'On battery' };
  else if (weakCharger) status = { tone: 'caution', word: 'Weak charger' };
  else status = { tone: 'nominal', word: b.charging ? 'Charging' : 'Plugged in' };

  const detail: string[] = [];
  if (weakCharger) detail.push(b.charging ? 'Charging slowly' : 'Plugged in, not charging');
  if (!onBattery && charger?.state === 'no-pd') detail.push(`5 V USB, no fast charging (${charger.watts} W)`);
  if (!onBattery && charger?.state === 'pd-low') detail.push(`Charger only ${charger.watts} W`);
  if (b.power?.mode === 'negative') detail.push(`Charger ${-b.power.marginW} W short of the load`);
  if (b.power?.mode === 'positive') detail.push(`${b.power.marginW} W spare`);
  if (b.lowPower) detail.push('Low power mode on');

  return { value: String(level), unit: '%', status, detail, fraction: Math.min(1, Math.max(0, level / 100)) };
}

/**
 * `argo posture` as a count of passing checks. A check Argo could not read is never counted as
 * passing; an empty posture reads as not reported. Fixes are on the device: `argo posture`.
 */
export function postureStatus(p: PostureReading | undefined): CardReading {
  const ids = (Object.keys(POSTURE_LABEL) as Array<keyof PostureReading['items']>).filter((id) => p?.items?.[id]);
  if (!p || ids.length === 0) return { value: '—', status: NOT_REPORTED, detail: [] };

  const names = (s: PostureStatus) => ids.filter((id) => p.items[id] === s).map((id) => POSTURE_LABEL[id]);
  const [ok, fail, warn, unknown] = [names('ok'), names('fail'), names('warn'), names('unknown')];

  let status: ReadoutStatus;
  if (fail.length) status = { tone: 'risk', word: 'Failing' };
  else if (warn.length) status = { tone: 'caution', word: 'Warning' };
  else if (unknown.length) status = { tone: 'caution', word: 'Not all read' };
  else status = { tone: 'nominal', word: 'All ok' };

  const detail: string[] = [];
  if (fail.length) detail.push(`Failing: ${fail.join(', ')}`);
  if (warn.length) detail.push(`Warning: ${warn.join(', ')}`);
  if (unknown.length) detail.push(`Not read: ${unknown.join(', ')}`);

  return { value: `${ok.length}/${ids.length}`, unit: 'checks ok', status, detail };
}
