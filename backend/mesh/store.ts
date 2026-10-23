import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  radio?: MeshRadio;
}

/**
 * Argo's radio profile and link quality (GAU-188): counts and grades only, never a
 * network name. "path" says where loss comes from: the Wi-Fi hop ("local") or past it.
 */
export const RADIO_BANDS = ["2.4", "5", "6"] as const;
export const LINK_PATHS = ["ok", "local", "upstream", "not measured"] as const;
export interface MeshRadio {
  band?: (typeof RADIO_BANDS)[number];
  channel?: number;
  widthMHz?: number;
  phy?: string;
  mcs?: number;
  txMbps?: number;
  coChannel?: number;
  overlapping?: number;
  gwLossPct?: number;
  gwJitterMs?: number;
  netLossPct?: number;
  netJitterMs?: number;
  netRttMs?: number;
  path?: (typeof LINK_PATHS)[number];
}

/** Reported by Argo (macOS, Linux) or by a phone Shortcut/automation (iOS, Android). */
export const MESH_PLATFORMS = ["macos", "linux", "windows", "ios", "android"] as const;
export type MeshPlatform = (typeof MESH_PLATFORMS)[number];
const PHONES: ReadonlySet<string> = new Set(["ios", "android"]);

export interface MeshBattery {
  level: number; // percent, 0-100
  charging: boolean;
  lowPower: boolean;
}

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
 * no: already under pressure or short of RAM/disk; unknown: older Argo.
 */
export type HostingVerdict = "agents" | "light" | "no" | "unknown";

export function hostingVerdict(host?: MeshHost, platform?: MeshPlatform): HostingVerdict {
  if (platform && PHONES.has(platform)) return "no"; // phones report status; they never host mesh work
  if (!host || !host.pressure) return "unknown";
  if (host.pressure !== "normal") return "no";
  if (host.ramGB >= 16 && host.diskFreeGB >= 20) return "agents";
  if (host.ramGB >= 8 && host.diskFreeGB >= 10) return "light";
  return "no";
}

export interface MeshDevice {
  name: string;
  owner: string; // user id of the admin who enrolled it
  tokenHash: string;
  enrolledAt: string;
  last?: MeshReport;
}

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
  return { level, charging: b.charging, lowPower: b.lowPower === true };
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
  const radio = parseRadio(n.radio);
  return { privacy, privacyWhy, rttMs, speed, signal, ...(measured ? { rssi, noise } : {}), ...(radio ? { radio } : {}) };
}

const WIDTHS: ReadonlySet<number> = new Set([20, 40, 80, 160, 320]);

/**
 * The optional radio block: every field allowlisted or range-checked. A bad field drops
 * the whole block (never the report), so a confused probe can't half-describe a link.
 */
export function parseRadio(value: unknown): MeshRadio | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const out: MeshRadio = {};
  const nums: [keyof MeshRadio, number, number][] = [
    ["channel", 1, 233], ["mcs", 0, 15], ["txMbps", 1, 10_000], ["coChannel", 0, 500], ["overlapping", 0, 500],
    ["gwLossPct", 0, 100], ["gwJitterMs", 0, 60_000], ["netLossPct", 0, 100], ["netJitterMs", 0, 60_000], ["netRttMs", 0, 60_000],
  ];
  for (const [key, min, max] of nums) {
    if (r[key] === undefined) continue;
    const v = int(r[key], min, max);
    if (v === null) return undefined;
    (out as Record<string, number>)[key] = v;
  }
  if (r.widthMHz !== undefined) {
    if (typeof r.widthMHz !== "number" || !WIDTHS.has(r.widthMHz)) return undefined;
    out.widthMHz = r.widthMHz;
  }
  if (r.band !== undefined) {
    if (!RADIO_BANDS.includes(r.band as MeshRadio["band"] & string)) return undefined;
    out.band = r.band as MeshRadio["band"];
  }
  if (r.phy !== undefined) {
    if (typeof r.phy !== "string" || !/^[a-z]{1,3}$/.test(r.phy)) return undefined;
    out.phy = r.phy;
  }
  if (r.path !== undefined) {
    if (!LINK_PATHS.includes(r.path as MeshRadio["path"] & string)) return undefined;
    out.path = r.path as MeshRadio["path"];
  }
  return Object.keys(out).length ? out : undefined;
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
    this.persist();
  }

  list(): Array<Omit<MeshDevice, "tokenHash"> & { hosting: HostingVerdict }> {
    this.reloadIfChanged();
    return [...this.devices.values()]
      .map(({ tokenHash: _hidden, ...rest }) => ({ ...rest, hosting: hostingVerdict(rest.last?.host, rest.last?.platform) }))
      .sort((a, b) => a.name.localeCompare(b.name));
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
