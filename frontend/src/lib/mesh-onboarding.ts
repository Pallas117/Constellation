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
}

/** "72% · plugged in", "48% · on battery", "100% charging": Argo says whether it's on mains, phones only whether they charge. */
export function batteryLabel(b: BatteryReading): string {
  const source = b.external === undefined ? (b.charging ? " charging" : "") : b.external ? (b.charging ? " charging" : " · plugged in") : " · on battery";
  return `${b.level}%${source}${b.lowPower ? " · low power" : ""}`;
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
