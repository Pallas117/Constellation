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

  list(): Array<Omit<MeshDevice, "tokenHash">> {
    this.reloadIfChanged();
    return [...this.devices.values()]
      .map(({ tokenHash: _hidden, ...rest }) => rest)
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
