import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { keyFingerprint, type DeviceKeys } from "./bundles.js";

// Mirrors Argo's classes (tools/argo/classify.go).
export const MESH_CLASSES = [
  "OK",
  "OFFLINE",
  "CAPTIVE",
  "DNS",
  "DEAD_PROXY",
  "STALE_DAEMON",
  "TLS_INTERCEPT",
  "PORT_BLOCK",
  "REGION",
  "WPAD_RISK",
  "WIFI_RISK",
] as const;
export type MeshClass = (typeof MESH_CLASSES)[number];

export interface MeshReport {
  class: MeshClass;
  reason: string;
  loc: string;
  network: string;
  tailscale: boolean;
  exitNode: string;
  breakerOpen: boolean;
  argoVersion: string;
  checkedAt: string;
  receivedAt: string;
  host?: MeshHost;
  platform?: MeshPlatform;
  battery?: MeshBattery;
  net?: MeshNet;
  link?: MeshLink;
  guard?: MeshGuard;
}

/**
 * Link stability from Argo's incident log (tools/argo/linkstats.go), for the
 * last 24 h and 7 days. availability is 0-1; -1 anywhere means not measured.
 */
export interface MeshLinkWindow {
  observedSec: number;
  availability: number;
  outages: number;
  downSec: number;
  mttrP50Sec: number;
  mttrP95Sec: number;
  mtbfSec: number;
}
export interface MeshLink {
  d1: MeshLinkWindow;
  d7: MeshLinkWindow;
}

const WEEK_SEC = 7 * 24 * 3600;

function parseLinkWindow(value: unknown): MeshLinkWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const w = value as Record<string, unknown>;
  const secs = (v: unknown) => int(v, -1, WEEK_SEC);
  const availability =
    typeof w.availability === "number" && Number.isFinite(w.availability) && (w.availability === -1 || (w.availability >= 0 && w.availability <= 1))
      ? Math.round(w.availability * 10_000) / 10_000
      : null;
  const out = {
    observedSec: secs(w.observedSec),
    availability,
    outages: int(w.outages, 0, 100_000),
    downSec: secs(w.downSec),
    mttrP50Sec: secs(w.mttrP50Sec),
    mttrP95Sec: secs(w.mttrP95Sec),
    mtbfSec: secs(w.mtbfSec),
  };
  return Object.values(out).some((v) => v === null) ? undefined : (out as MeshLinkWindow);
}

/** Both windows or nothing; any field out of range drops the block. */
export function parseLink(value: unknown): MeshLink | undefined {
  if (!value || typeof value !== "object") return undefined;
  const l = value as Record<string, unknown>;
  const d1 = parseLinkWindow(l.d1);
  const d7 = parseLinkWindow(l.d7);
  return d1 && d7 ? { d1, d7 } : undefined;
}

/**
 * Network scores computed by Argo from what it measured (tools/argo/netscore.go):
 * privacy 0-100 with a reason per point lost, round-trip latency and Wi-Fi signal.
 * -1 / "not measured" means Argo couldn't measure it; it is never a guess.
 */
export const NET_GRADES = ["excellent", "good", "fair", "poor", "not measured"] as const;
export type NetGrade = (typeof NET_GRADES)[number];
export interface MeshNet {
  privacy: number; // -1 not measured
  privacyWhy: string[];
  rttMs: number; // -1 not measured
  speed: NetGrade;
  signal: NetGrade | "n/a";
  rssi?: number;
  noise?: number;
}

/** Reported by Argo (macOS, Linux) or by a phone Shortcut/automation (iOS, Android). */
export const MESH_PLATFORMS = ["macos", "linux", "windows", "ios", "android"] as const;
export type MeshPlatform = (typeof MESH_PLATFORMS)[number];
const PHONES: ReadonlySet<string> = new Set(["ios", "android"]);

export interface MeshBattery {
  level: number; // percent, 0-100
  charging: boolean;
  lowPower: boolean;
  external?: boolean; // on mains power (Argo sends it; phones don't)
}

/**
 * Argo's resource guard (tools/argo/guard.go, GAU-195): the host's own risk
 * level, whether it admits new work, how many agent slots it offers after
 * its autoscaler's cool-down, and finding codes. The codes are an allowlist
 * with the plain words the page shows; unknown codes are dropped.
 */
export const GUARD_CODE_TEXT = {
  "mem-critical": "memory pressure critical",
  "mem-warn-sustained": "memory at warn for 30+ of the last 60 min",
  "mem-paging": "swapping out fast: memory short",
  "mem-warn-coping": "memory at warn but coping",
  "mem-warn": "memory pressure at warn",
  "pressure-unknown": "memory pressure unknown",
  "swap-rising": "swap climbing at warn",
  "swap-high": "swap over 4 GB",
  "no-headroom": "no spare RAM",
  "battery-floor": "battery at the 10% floor",
  "battery-low": "battery low",
  "battery-draining": "under an hour to the battery floor",
  "battery-low-pressure": "low battery with memory at warn",
  "on-battery": "on battery power",
  "charger-behind": "charger can't keep up",
  "charger-weak": "charger weaker than the draw",
  "disk-critical": "disk nearly full",
  "disk-low": "disk low",
  "disk-tight": "disk under 20 GB free",
  "cpu-throttled": "CPU throttled",
  "cpu-saturated": "CPU saturated",
  "cpu-busy": "CPU busy",
} as const;
export type GuardCode = keyof typeof GUARD_CODE_TEXT;
export const GUARD_LEVELS = ["ok", "watch", "risk", "block"] as const;
export const GUARD_ADMISSIONS = ["open", "full", "limited", "closed"] as const;
export interface MeshGuard {
  at: string;
  level: (typeof GUARD_LEVELS)[number];
  admission: (typeof GUARD_ADMISSIONS)[number];
  slots: number;
  headroomGB: number;
  reasons: GuardCode[];
  warnMin: number;
  swapRiseGB: number;
  minToFloor: number; // -1 unknown or on mains
}

/** Reports older than this say nothing about the device now (the page marks them stale too). */
export const MESH_STALE_MS = 15 * 60_000;

/** Host capacity from Argo (tools/argo/capacity.go): sizes and kernel pressure only. */
export interface MeshHost {
  ramGB: number;
  pressure: "normal" | "warn" | "critical" | "";
  swapUsedGB: number;
  diskFreeGB: number;
  cpus: number;
  os: string;
}

/**
 * Where a device can take mesh work. agents: room for agent runtimes and a
 * shared-memory replica; light: Argo, monitoring and small local models;
 * no: already under pressure or short of RAM/disk; unknown: older Argo or no
 * recent report.
 */
export type HostingVerdict = "agents" | "light" | "no" | "unknown";
const VERDICT_RANK: Record<HostingVerdict, number> = { unknown: -1, no: 0, light: 1, agents: 2 };

export interface HostingContext {
  battery?: MeshBattery;
  guard?: MeshGuard;
  receivedAt?: string;
  now?: Date;
}

/**
 * The verdict and the plain reasons behind it, for the device list. The
 * hardware floor comes first, then each newer signal can only lower it:
 * a stale report, battery power, swap, and Argo's own guard (which also
 * holds a new or recovered host back for its 10-minute cool-down).
 */
export function assessHosting(host?: MeshHost, platform?: MeshPlatform, ctx: HostingContext = {}): { verdict: HostingVerdict; why: string[] } {
  if (platform && PHONES.has(platform)) return { verdict: "no", why: ["phones report status only"] }; // they never host mesh work
  const now = ctx.now ?? new Date();
  const age = ctx.receivedAt ? now.getTime() - Date.parse(ctx.receivedAt) : 0;
  if (age > MESH_STALE_MS) return { verdict: "unknown", why: [`no report for ${Math.round(age / 60_000)} min`] };
  if (!host || !host.pressure) return { verdict: "unknown", why: ["no capacity reading yet: update Argo on the device"] };
  const why: string[] = [];
  let verdict: HostingVerdict = "no";
  if (host.ramGB >= 16 && host.diskFreeGB >= 20) verdict = "agents";
  else if (host.ramGB >= 8 && host.diskFreeGB >= 10) verdict = "light";
  else why.push(`needs 8 GB RAM and 10 GB free disk (has ${host.ramGB} GB, ${host.diskFreeGB} GB free)`);
  const cap = (max: HostingVerdict, reason: string) => {
    if (VERDICT_RANK[max] < VERDICT_RANK[verdict]) verdict = max;
    if (VERDICT_RANK[max] < VERDICT_RANK.agents) why.push(reason);
  };
  if (host.pressure !== "normal") cap("no", `memory pressure ${host.pressure}`);
  if (host.swapUsedGB >= 4) cap("no", `${host.swapUsedGB} GB of swap in use`);
  const b = ctx.battery;
  const onBattery = b ? (b.external ?? b.charging) === false : false;
  if (b && onBattery && b.level <= 20) cap("no", `battery ${b.level}% on battery power`);
  else if (b && onBattery) cap("light", "on battery power: light work only");
  const g = ctx.guard;
  const guardFresh = g && ctx.receivedAt && Math.abs(Date.parse(ctx.receivedAt) - Date.parse(g.at)) <= MESH_STALE_MS;
  if (g && guardFresh) {
    const codes = g.reasons.filter((c) => c !== "no-headroom" || g.admission === "full").map((c) => GUARD_CODE_TEXT[c]);
    const detail = codes.length ? `: ${codes.join(", ")}` : "";
    if (g.admission === "closed") cap("no", `Argo guard closed to new work${detail}`);
    else if (g.admission === "full") cap("no", "Argo guard: no spare RAM for new work");
    else if (g.admission === "limited") cap("light", `Argo guard: light work only${detail}`);
    else if (g.slots === 0) cap("light", "Argo guard: cooling down (10 calm minutes before taking work)");
    else if (g.slots === 1) cap("light", "Argo guard: 1 agent slot free");
  }
  return { verdict, why: [...new Set(why)] };
}

export function hostingVerdict(host?: MeshHost, platform?: MeshPlatform, ctx: HostingContext = {}): HostingVerdict {
  return assessHosting(host, platform, ctx).verdict;
}

export interface MeshDevice {
  name: string;
  owner: string; // user id of the admin who enrolled it
  tokenHash: string;
  enrolledAt: string;
  last?: MeshReport;
  keys?: DeviceKeys; // public keys for end-to-end encrypted delivery (bundles.ts)
  /** When Gauss last refused a report from this device as invalid (e.g. a class it doesn't know yet). */
  rejectedAt?: string;
}

export type MeshDeviceView = Omit<MeshDevice, "tokenHash" | "keys"> & { hosting: HostingVerdict; hostingWhy: string[]; keyFingerprint?: string };

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_TEXT = 200;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const text = (value: unknown, max = MAX_TEXT) => (typeof value === "string" ? value.slice(0, max) : "");

const num = (value: unknown, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value * 10) / 10 : null;

/** Battery from a phone reporter: integer percent 0-100 and two flags; anything else drops the block. */
export function parseBattery(value: unknown): MeshBattery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const b = value as Record<string, unknown>;
  // Shortcuts' "Battery Level" can arrive as a fraction (0.83) or a percent (83).
  const raw = typeof b.level === "number" && Number.isFinite(b.level) ? b.level : NaN;
  const level = raw > 0 && raw <= 1 && !Number.isInteger(raw) ? Math.round(raw * 100) : Math.round(raw);
  if (!(level >= 0 && level <= 100)) return undefined;
  if (typeof b.charging !== "boolean") return undefined;
  return { level, charging: b.charging, lowPower: b.lowPower === true, ...(typeof b.external === "boolean" ? { external: b.external } : {}) };
}

const isGuardCode = (c: unknown): c is GuardCode => typeof c === "string" && Object.hasOwn(GUARD_CODE_TEXT, c);

/** Argo's guard decision; a bad level, admission or number drops the block, unknown codes are dropped alone. */
export function parseGuard(value: unknown): MeshGuard | undefined {
  if (!value || typeof value !== "object") return undefined;
  const g = value as Record<string, unknown>;
  const level = GUARD_LEVELS.includes(g.level as MeshGuard["level"]) ? (g.level as MeshGuard["level"]) : null;
  const admission = GUARD_ADMISSIONS.includes(g.admission as MeshGuard["admission"]) ? (g.admission as MeshGuard["admission"]) : null;
  const slots = int(g.slots, 0, 1024);
  const headroomGB = num(g.headroomGB, 4096);
  const warnMin = int(g.warnMin, 0, 60);
  const swapRiseGB = num(g.swapRiseGB, 4096);
  const minToFloor = int(g.minToFloor, -1, 100_000);
  const at = text(g.at, 40);
  if (level === null || admission === null || slots === null || headroomGB === null || warnMin === null || swapRiseGB === null || minToFloor === null || Number.isNaN(Date.parse(at))) {
    return undefined;
  }
  const reasons = (Array.isArray(g.reasons) ? g.reasons : []).filter(isGuardCode).slice(0, 6);
  return { at, level, admission, slots, headroomGB, reasons, warnMin, swapRiseGB, minToFloor };
}

const WHY_RE = /^[A-Za-z0-9 ()/,.-]{1,80}$/;
const int = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;

/** Allowlisted network scores; a bad score or grade drops the block, a bad reason is dropped alone. */
export function parseNet(value: unknown): MeshNet | undefined {
  if (!value || typeof value !== "object") return undefined;
  const n = value as Record<string, unknown>;
  const privacy = int(n.privacy, -1, 100);
  const rttMs = int(n.rttMs, -1, 60_000);
  const speed = NET_GRADES.includes(n.speed as NetGrade) ? (n.speed as NetGrade) : null;
  const signal = n.signal === "n/a" || NET_GRADES.includes(n.signal as NetGrade) ? (n.signal as MeshNet["signal"]) : null;
  if (privacy === null || rttMs === null || speed === null || signal === null) return undefined;
  const why = Array.isArray(n.privacyWhy) ? n.privacyWhy : [];
  const privacyWhy = why.filter((w): w is string => typeof w === "string" && WHY_RE.test(w)).slice(0, 8);
  const rssi = int(n.rssi, -120, 0);
  const noise = int(n.noise, -120, 0);
  const measured = signal !== "n/a" && signal !== "not measured" && rssi !== null && noise !== null;
  return { privacy, privacyWhy, rttMs, speed, signal, ...(measured ? { rssi, noise } : {}) };
}

/** Allowlisted, range-checked host capacity; anything outside the ranges drops the whole block. */
export function parseHost(value: unknown): MeshHost | undefined {
  if (!value || typeof value !== "object") return undefined;
  const h = value as Record<string, unknown>;
  const ramGB = num(h.ramGB, 4096);
  const swapUsedGB = num(h.swapUsedGB, 4096);
  const diskFreeGB = num(h.diskFreeGB, 1_000_000);
  const cpus = typeof h.cpus === "number" && Number.isInteger(h.cpus) && h.cpus >= 1 && h.cpus <= 1024 ? h.cpus : null;
  const pressure = ["normal", "warn", "critical", ""].includes(h.pressure as string) ? (h.pressure as MeshHost["pressure"]) : null;
  if (ramGB === null || swapUsedGB === null || diskFreeGB === null || cpus === null || pressure === null) return undefined;
  const os = text(h.os, 10);
  return { ramGB, pressure, swapUsedGB, diskFreeGB, cpus, os: /^[a-z]+$/.test(os) ? os : "" };
}

/**
 * Validates an Argo report against an allowlist of fields. Anything else the
 * agent sends (or an attacker adds) is dropped, never stored.
 */
export function parseReport(body: unknown, now = new Date()): MeshReport | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!MESH_CLASSES.includes(b.class as MeshClass)) return null;
  const loc = text(b.loc, 2).toUpperCase();
  return {
    class: b.class as MeshClass,
    reason: text(b.reason),
    loc: /^[A-Z]{2}$/.test(loc) ? loc : "",
    network: /^[0-9a-f]{12}$/.test(text(b.network, 12)) ? text(b.network, 12) : "",
    tailscale: b.tailscale === true,
    exitNode: NAME_RE.test(text(b.exitNode, 63)) ? text(b.exitNode, 63) : "",
    breakerOpen: b.breakerOpen === true,
    argoVersion: text(b.argoVersion, 20),
    checkedAt: Number.isNaN(Date.parse(text(b.checkedAt, 40))) ? "" : text(b.checkedAt, 40),
    receivedAt: now.toISOString(),
    ...(parseHost(b.host) ? { host: parseHost(b.host) } : {}),
    ...(MESH_PLATFORMS.includes(b.platform as MeshPlatform) ? { platform: b.platform as MeshPlatform } : {}),
    ...(parseBattery(b.battery) ? { battery: parseBattery(b.battery) } : {}),
    ...(parseNet(b.net) ? { net: parseNet(b.net) } : {}),
    ...(parseLink(b.link) ? { link: parseLink(b.link) } : {}),
    ...(parseGuard(b.guard) ? { guard: parseGuard(b.guard) } : {}),
  };
}

/** Device tokens are stored only as SHA-256 hashes; the plain token is shown once at enrollment. */
export class MeshStore {
  private devices = new Map<string, MeshDevice>();
  private loadedMtimeMs = -1;

  constructor(private readonly file: string | null) {
    this.reloadIfChanged();
  }

  /**
   * `npm run mesh:enroll` writes the same file from another process while the
   * server runs; reload it when it changed so new devices work immediately and
   * the server's next write doesn't drop them.
   */
  private reloadIfChanged(): void {
    if (!this.file || !fs.existsSync(this.file)) return;
    const mtime = fs.statSync(this.file).mtimeMs;
    if (mtime === this.loadedMtimeMs) return;
    this.devices.clear();
    for (const d of JSON.parse(fs.readFileSync(this.file, "utf8")) as MeshDevice[]) {
      this.devices.set(d.name, d);
    }
    this.loadedMtimeMs = mtime;
  }

  enroll(name: string, owner: string): { device: MeshDevice; token: string } | { error: string } {
    this.reloadIfChanged();
    if (!NAME_RE.test(name)) return { error: "Device name must be lowercase letters, digits and dashes" };
    if (this.devices.has(name)) return { error: "Device already enrolled; revoke it first" };
    const token = `argo_${randomBytes(32).toString("base64url")}`;
    const device: MeshDevice = { name, owner, tokenHash: hashToken(token), enrolledAt: new Date().toISOString() };
    this.devices.set(name, device);
    this.persist();
    return { device, token };
  }

  revoke(name: string): boolean {
    this.reloadIfChanged();
    const removed = this.devices.delete(name);
    if (removed) this.persist();
    return removed;
  }

  byToken(token: string): MeshDevice | undefined {
    this.reloadIfChanged();
    const h = hashToken(token);
    for (const d of this.devices.values()) {
      if (d.tokenHash === h) return d;
    }
    return undefined;
  }

  record(device: MeshDevice, report: MeshReport): void {
    device.last = report;
    delete device.rejectedAt;
    this.persist();
  }

  /**
   * Remember that a report from this device was refused, so the page can say
   * why it looks silent. At most one write a minute per device: a broken
   * agent must not turn into a write loop.
   */
  reject(device: MeshDevice, now = new Date()): void {
    if (device.rejectedAt && now.getTime() - Date.parse(device.rejectedAt) < 60_000) return;
    device.rejectedAt = now.toISOString();
    this.persist();
  }

  list(now = new Date()): MeshDeviceView[] {
    this.reloadIfChanged();
    return [...this.devices.values()]
      .map(({ tokenHash: _hidden, keys, ...rest }) => {
        const l = rest.last;
        const { verdict, why } = assessHosting(l?.host, l?.platform, { battery: l?.battery, guard: l?.guard, receivedAt: l?.receivedAt, now });
        return { ...rest, hosting: verdict, hostingWhy: why, ...(keys ? { keyFingerprint: keyFingerprint(keys) } : {}) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    this.reloadIfChanged();
    return this.devices.has(name);
  }

  /**
   * The first key set a device publishes is kept. A different one later is
   * refused: replacing it would let whoever holds the token read files meant
   * for the old key. An admin revokes and re-enrolls the device instead.
   */
  setKeys(device: MeshDevice, keys: DeviceKeys): "created" | "same" | "conflict" {
    this.reloadIfChanged();
    const d = this.devices.get(device.name);
    if (!d) return "conflict";
    if (d.keys) return keyFingerprint(d.keys) === keyFingerprint(keys) ? "same" : "conflict";
    d.keys = keys;
    this.persist();
    return "created";
  }

  directory(): Array<{ node: string; sign: string; kem_id: number; kem: string }> {
    this.reloadIfChanged();
    return [...this.devices.values()]
      .filter((d) => d.keys)
      .map((d) => ({ node: d.name, sign: d.keys!.sign, kem_id: d.keys!.kem_id, kem: d.keys!.kem }))
      .sort((a, b) => a.node.localeCompare(b.node));
  }

  private persist(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.devices.values()], null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.loadedMtimeMs = fs.statSync(this.file).mtimeMs;
  }
}
