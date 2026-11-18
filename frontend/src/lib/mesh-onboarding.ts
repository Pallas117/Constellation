/**
 * Onboarding logic for the /mesh page (GAU-195), kept free of React so it is
 * unit-tested with the backend suite.
 */

/** CyberTiger counts 401s and 403s and auto-blocks the address: a page that gets one stops polling. */
export function stopsPolling(status: number): boolean {
  return status === 401 || status === 403;
}

const TAILNET_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/; // 100.64.0.0/10

/** Argo only reports to a tailnet address (tools/argo tailnetOnly); this page's own is one when opened over the tailnet. */
export function isTailnetHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h.endsWith(".ts.net") || TAILNET_V4.test(h) || h.startsWith("fd7a:115c:a1e0:");
}

/**
 * The exact `argo enroll` command for a device. The page and its API share an
 * origin (/api is forwarded by vite preview and tailscale serve), so when the
 * page is open over the tailnet its own origin is the Gauss URL Argo needs.
 */
export function enrollCommand(loc: { protocol: string; host: string; hostname: string }, device: string): { command: string; exact: boolean } {
  if (isTailnetHost(loc.hostname)) return { command: `argo enroll ${loc.protocol}//${loc.host} ${device}`, exact: true };
  return { command: `argo enroll http://<this-gauss-tailnet-name> ${device}`, exact: false };
}

export interface OnboardingDevice {
  enrolledAt: string;
  rejectedAt?: string;
  last?: { receivedAt: string };
}

export type DeviceStage = "waiting" | "silent" | "rejected" | "stale" | "reporting";

const FIRST_REPORT_GRACE_MS = 10 * 60_000;
export const STALE_MS = 15 * 60_000;

/** Where a device is on its way to reporting, so a silent one gets a next step instead of a bare "Never reported". */
export function deviceStage(d: OnboardingDevice, now: number): DeviceStage {
  if (d.rejectedAt && (!d.last || Date.parse(d.rejectedAt) > Date.parse(d.last.receivedAt))) return "rejected";
  if (!d.last) return now - Date.parse(d.enrolledAt) > FIRST_REPORT_GRACE_MS ? "silent" : "waiting";
  return now - Date.parse(d.last.receivedAt) > STALE_MS ? "stale" : "reporting";
}

export const STAGE_HELP: Record<Exclude<DeviceStage, "reporting">, string> = {
  waiting: "Waiting for the first report. Argo sends one as soon as `argo enroll` finishes.",
  silent:
    "No report yet. On the device run `argo status`: “gauss:token-refused” means the token was mistyped or revoked (revoke this row and enroll again); otherwise run `argo doctor` and check Tailscale is on.",
  rejected: "Gauss refused this device's last report: its Argo is older or newer than this Gauss. Update Argo on the device (build from this repo).",
  stale: "No report for over 15 minutes: the device is asleep, offline or Argo is paused (`argo on`).",
};

export interface BatteryReading {
  level: number;
  charging: boolean;
  lowPower: boolean;
  external?: boolean;
  power?: { mode: "positive" | "negative" | "eclipse"; sourceW: number; loadW: number; marginW: number };
}

/**
 * "72% · plugged in · 9.5 W spare", "48% · on battery", "100% charging": Argo says whether it's on mains and its power
 * margin (tools/argo/power.go), phones only whether they charge.
 */
export function batteryLabel(b: BatteryReading): string {
  const source = b.external === undefined ? (b.charging ? " charging" : "") : b.external ? (b.charging ? " charging" : " · plugged in") : " · on battery";
  const p = b.power;
  const margin = p?.mode === "positive" ? ` · ${p.marginW} W spare` : p?.mode === "negative" ? ` · charger ${-p.marginW} W short` : "";
  return `${b.level}%${source}${margin}${b.lowPower ? " · low power" : ""}`;
}

export interface GuardReading {
  admission: "open" | "full" | "limited" | "closed";
  slots: number;
  headroomGB: number;
}

/** One line from Argo's guard: what this host offers the mesh right now. */
export function guardLine(g: GuardReading): string {
  const slots = `${g.slots} agent slot${g.slots === 1 ? "" : "s"}`;
  const label = { open: "open", full: "full", limited: "light work only", closed: "closed to new work" }[g.admission];
  return `Argo guard: ${label} · ${slots} · ${g.headroomGB} GB free`;
}

export type PostureStatus = "ok" | "warn" | "fail" | "unknown";
export interface PostureReading {
  at: string;
  items: Partial<Record<"disk" | "firewall" | "updates" | "integrity" | "tailkey" | "argo" | "sharing", PostureStatus>>;
}

const POSTURE_LABEL: Record<keyof PostureReading["items"], string> = {
  disk: "disk encryption",
  firewall: "firewall",
  updates: "automatic updates",
  integrity: "system integrity",
  tailkey: "tailnet key",
  argo: "Argo version",
  sharing: "sharing services",
};

/**
 * One line from `argo posture` (docs/DEVICE_SECURITY_BASELINE.md): how many checks pass and which need a look.
 * "not read" is a check Argo could not make, never counted as passing. Details and fixes: `argo posture` on the device.
 */
export function postureLine(p: PostureReading): string {
  const ids = Object.keys(POSTURE_LABEL) as Array<keyof PostureReading["items"]>;
  const seen = ids.filter((id) => p.items[id]);
  const names = (s: PostureStatus) => seen.filter((id) => p.items[id] === s).map((id) => POSTURE_LABEL[id]);
  const parts = [`Security: ${names("ok").length} of ${seen.length} checks ok`];
  if (names("fail").length) parts.push(`failing: ${names("fail").join(", ")}`);
  if (names("warn").length) parts.push(`warning: ${names("warn").join(", ")}`);
  if (names("unknown").length) parts.push(`not read: ${names("unknown").join(", ")}`);
  return parts.join(" · ");
}

/**
 * Copy text to the clipboard. On plain-http tailnet pages (not a secure
 * context) navigator.clipboard is missing, so say how to copy by hand
 * instead of failing silently.
 */
export async function copyText(text: string, clipboard: Pick<Clipboard, "writeText"> | undefined): Promise<"copied" | "manual"> {
  if (!clipboard) return "manual";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "manual";
  }
}
