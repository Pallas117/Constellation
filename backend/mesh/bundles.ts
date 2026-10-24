import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Store-and-forward mailbox for Argo's delay-tolerant delivery (tools/argo/relay.go).
 *
 * Devices upload Bundle Protocol v7 bundles (RFC 9171) addressed to another
 * enrolled device and fetch the ones addressed to them. Payloads are sealed
 * end to end (HPKE, post-quantum hybrid) and signed by the sending device, so
 * this hub stores ciphertext it cannot read or alter. It reads only the
 * primary block: who from, who to, creation time and lifetime. It checks
 * that the uploader is the bundle's source (device token → device name),
 * enforces lifetimes and quotas, and keeps a tombstone when a bundle is
 * picked up so its sender can tell "taken" from "lost".
 */

export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024; // Argo sends 1 MiB chunks plus ~1.3 KB of headers
export const MAX_LIFETIME_MS = 30 * 24 * 3600 * 1000;
export const MAX_QUEUE_BUNDLES = 2048;
export const MAX_QUEUE_BYTES = 512 * 1024 * 1024;
const CLOCK_SKEW_MS = 24 * 3600 * 1000;
const FLAG_FRAGMENT = 0x1;
export const BUNDLE_ID_RE = /^[0-9a-f]{32}$/;

// ---- CRC-16/X-25 and CRC-32C (RFC 9171 §4.2.1) ----

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC32C_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function crcX25(buf: Uint8Array): number {
  let c = 0xffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
  }
  return ~c & 0xffff;
}

// ---- just enough CBOR (RFC 8949) to read a primary block ----

class CborReader {
  constructor(
    readonly b: Uint8Array,
    public i = 0,
  ) {}

  private head(): { major: number; value: number; indef: boolean } {
    if (this.i >= this.b.length) throw new Error("truncated");
    const ib = this.b[this.i++];
    const major = ib >> 5;
    const info = ib & 0x1f;
    if (info < 24) return { major, value: info, indef: false };
    if (info === 31 && major >= 2 && major <= 5) return { major, value: 0, indef: true };
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (n === 0 || this.i + n > this.b.length) throw new Error("bad head");
    let v = 0n;
    for (let k = 0; k < n; k++) v = (v << 8n) | BigInt(this.b[this.i++]);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("integer too large");
    return { major, value: Number(v), indef: false };
  }

  private want(major: number): number {
    const h = this.head();
    if (h.major !== major || h.indef) throw new Error(`want major type ${major}`);
    return h.value;
  }

  uint(): number {
    return this.want(0);
  }

  array(): number {
    const n = this.want(4);
    if (n > this.b.length - this.i) throw new Error("bad array length");
    return n;
  }

  span(n: number): Uint8Array {
    if (n > this.b.length - this.i) throw new Error("truncated");
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }

  bytes(): Uint8Array {
    return this.span(this.want(2));
  }

  text(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.span(this.want(3)));
  }

  isUint(): boolean {
    return this.i < this.b.length && this.b[this.i] >> 5 === 0;
  }
}

function readEid(r: CborReader): string {
  if (r.array() !== 2) throw new Error("bad EID");
  const scheme = r.uint();
  if (scheme === 1) {
    if (r.isUint()) {
      if (r.uint() !== 0) throw new Error("bad dtn EID");
      return "dtn:none";
    }
    const ssp = r.text();
    if (ssp.length > 255 || !/^\/\/[!-~]+$/.test(ssp)) throw new Error("bad dtn EID");
    return `dtn:${ssp}`;
  }
  if (scheme === 2) {
    const n = r.array();
    if (n < 2 || n > 3) throw new Error("bad ipn EID");
    const parts: number[] = [];
    for (let k = 0; k < n; k++) parts.push(r.uint());
    return `ipn:${parts.join(".")}`;
  }
  throw new Error("unsupported EID scheme");
}

export interface PrimaryBlock {
  flags: number;
  dest: string;
  source: string;
  reportTo: string;
  createdMs: number; // DTN time: ms since 2000-01-01T00:00:00Z
  seq: number;
  lifetimeMs: number;
  /** Same value as Primary.Key() in tools/argo/bundle.go. */
  id: string;
}

const DTN_EPOCH_MS = Date.UTC(2000, 0, 1);
export const dtnToDate = (ms: number) => new Date(DTN_EPOCH_MS + ms);

export const bundleId = (source: string, createdMs: number, seq: number) =>
  createHash("sha256").update(`${source}|${createdMs}|${seq}`).digest("hex").slice(0, 32);

/** Parses and CRC-checks the primary block of a bundle; throws on anything malformed. */
export function parsePrimary(raw: Uint8Array): PrimaryBlock {
  if (raw.length < 2 || raw[0] !== 0x9f) throw new Error("not a BPv7 bundle");
  const r = new CborReader(raw, 1);
  const start = r.i;
  const n = r.array();
  if (n < 8 || n > 11) throw new Error("bad primary block");
  if (r.uint() !== 7) throw new Error("not BPv7");
  const flags = r.uint();
  const crcType = r.uint();
  if (crcType > 2) throw new Error("bad CRC type");
  const dest = readEid(r);
  const source = readEid(r);
  const reportTo = readEid(r);
  if (r.array() !== 2) throw new Error("bad creation timestamp");
  const createdMs = r.uint();
  const seq = r.uint();
  const lifetimeMs = r.uint();
  let want = 8;
  if (flags & FLAG_FRAGMENT) {
    want += 2;
    r.uint();
    r.uint();
  }
  if (crcType !== 0) {
    want++;
    const crc = r.bytes();
    const len = crcType === 1 ? 2 : 4;
    if (crc.length !== len) throw new Error("bad CRC field");
    const block = Uint8Array.from(raw.subarray(start, r.i));
    block.fill(0, block.length - len);
    const got = Buffer.from(crc).readUIntBE(0, len);
    if ((crcType === 1 ? crcX25(block) : crc32c(block)) !== got) throw new Error("primary block CRC mismatch");
  }
  if (n !== want) throw new Error("primary block has the wrong number of fields");
  return { flags, dest, source, reportTo, createdMs, seq, lifetimeMs, id: bundleId(source, createdMs, seq) };
}

/** dtn://<device>/... → device, or "" for anything else. */
export function deviceOf(eid: string): string {
  const m = /^dtn:\/\/([a-z0-9][a-z0-9-]{0,62})\/[A-Za-z0-9._~-]{0,64}$/.exec(eid);
  return m ? m[1] : "";
}

// ---- the mailbox ----

export interface QueuedBundle {
  id: string;
  dest: string;
  from: string;
  size: number;
  receivedAt: string;
  expiresAt: string;
}

interface Tombstone {
  id: string;
  from: string;
  takenAt: string;
  expiresAt: string;
}

interface Index {
  queued: QueuedBundle[];
  taken: Tombstone[];
}

export type PutResult =
  | { ok: true; status: 201 | 200; id: string; duplicate: boolean }
  | { ok: false; status: 403 | 404 | 422 | 429; error: string };

export type BundleState = "queued" | "picked-up" | "unknown";

/**
 * Bundles live as files under dir/<dest>/<id>.bundle (0600) with one JSON
 * index. dir null keeps everything in memory (tests).
 */
export class BundleStore {
  private index: Index = { queued: [], taken: [] };
  private mem = new Map<string, Buffer>();

  constructor(
    private readonly dir: string | null,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (dir && fs.existsSync(path.join(dir, "index.json"))) {
      this.index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")) as Index;
    }
  }

  private file(dest: string, id: string) {
    return path.join(this.dir as string, dest, `${id}.bundle`);
  }

  private persist(): void {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = path.join(this.dir, "index.json");
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(this.index), { mode: 0o600 });
    fs.renameSync(`${p}.tmp`, p);
  }

  private remove(b: QueuedBundle): void {
    this.mem.delete(b.id);
    if (this.dir) fs.rmSync(this.file(b.dest, b.id), { force: true });
  }

  /** Drops expired bundles and tombstones. */
  sweep(now = this.clock()): void {
    const t = now.getTime();
    const before = this.index.queued.length + this.index.taken.length;
    this.index.queued = this.index.queued.filter((b) => {
      const keep = Date.parse(b.expiresAt) > t;
      if (!keep) this.remove(b);
      return keep;
    });
    this.index.taken = this.index.taken.filter((s) => Date.parse(s.expiresAt) > t);
    if (this.index.queued.length + this.index.taken.length !== before) this.persist();
  }

  put(uploader: string, raw: Buffer, isEnrolled: (device: string) => boolean, now = this.clock()): PutResult {
    let p: PrimaryBlock;
    try {
      p = parsePrimary(raw);
    } catch (err) {
      return { ok: false, status: 422, error: `Not a valid bundle: ${(err as Error).message}` };
    }
    if (p.flags & FLAG_FRAGMENT) return { ok: false, status: 422, error: "Fragments are not accepted" };
    if (p.source !== `dtn://${uploader}/`) return { ok: false, status: 403, error: "Bundle source is not this device" };
    const dest = deviceOf(p.dest);
    if (!dest || dest === uploader || !isEnrolled(dest)) return { ok: false, status: 404, error: "Unknown destination device" };
    const created = dtnToDate(p.createdMs).getTime();
    const expires = created + p.lifetimeMs;
    if (p.lifetimeMs > MAX_LIFETIME_MS) return { ok: false, status: 422, error: "Lifetime longer than 30 days" };
    if (created > now.getTime() + CLOCK_SKEW_MS || expires <= now.getTime()) {
      return { ok: false, status: 422, error: "Bundle is expired or from the future" };
    }
    this.sweep(now);
    if (this.index.queued.some((b) => b.id === p.id) || this.index.taken.some((s) => s.id === p.id)) {
      return { ok: true, status: 200, id: p.id, duplicate: true };
    }
    const queue = this.index.queued.filter((b) => b.dest === dest);
    const bytes = queue.reduce((sum, b) => sum + b.size, 0);
    if (queue.length >= MAX_QUEUE_BUNDLES || bytes + raw.length > MAX_QUEUE_BYTES) {
      return { ok: false, status: 429, error: "Destination mailbox is full; retry later" };
    }
    const entry: QueuedBundle = { id: p.id, dest, from: uploader, size: raw.length, receivedAt: now.toISOString(), expiresAt: new Date(expires).toISOString() };
    if (this.dir) {
      fs.mkdirSync(path.join(this.dir, dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file(dest, p.id), raw, { mode: 0o600 });
    } else {
      this.mem.set(p.id, Buffer.from(raw));
    }
    this.index.queued.push(entry);
    this.persist();
    return { ok: true, status: 201, id: p.id, duplicate: false };
  }

  list(device: string, now = this.clock()): QueuedBundle[] {
    this.sweep(now);
    return this.index.queued.filter((b) => b.dest === device).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  get(device: string, id: string): Buffer | null {
    const b = this.index.queued.find((x) => x.id === id && x.dest === device);
    if (!b) return null;
    if (!this.dir) return this.mem.get(id) ?? null;
    try {
      return fs.readFileSync(this.file(b.dest, b.id));
    } catch {
      return null;
    }
  }

  /** The destination took it: delete the bundle, keep a tombstone until it would have expired. */
  ack(device: string, id: string, now = this.clock()): boolean {
    const b = this.index.queued.find((x) => x.id === id && x.dest === device);
    if (!b) return false;
    this.remove(b);
    this.index.queued = this.index.queued.filter((x) => x !== b);
    this.index.taken.push({ id: b.id, from: b.from, takenAt: now.toISOString(), expiresAt: b.expiresAt });
    this.persist();
    return true;
  }

  /** What happened to bundles this device sent; nothing about anyone else's. */
  status(device: string, ids: string[]): Record<string, BundleState> {
    const out: Record<string, BundleState> = {};
    for (const id of ids) {
      if (this.index.queued.some((b) => b.id === id && b.from === device)) out[id] = "queued";
      else if (this.index.taken.some((s) => s.id === id && s.from === device)) out[id] = "picked-up";
      else out[id] = "unknown";
    }
    return out;
  }

  /** Waiting bundles per destination: counts and sizes only. */
  queueStats(): Map<string, { queued: number; bytes: number; oldest: string }> {
    const out = new Map<string, { queued: number; bytes: number; oldest: string }>();
    for (const b of this.index.queued) {
      const s = out.get(b.dest) ?? { queued: 0, bytes: 0, oldest: b.receivedAt };
      s.queued++;
      s.bytes += b.size;
      if (b.receivedAt < s.oldest) s.oldest = b.receivedAt;
      out.set(b.dest, s);
    }
    return out;
  }

  /** A revoked device's mailbox goes with it, and so do bundles it sent that nobody took yet. */
  purge(device: string): void {
    for (const b of this.index.queued.filter((x) => x.dest === device || x.from === device)) this.remove(b);
    this.index.queued = this.index.queued.filter((x) => x.dest !== device && x.from !== device);
    this.index.taken = this.index.taken.filter((s) => s.from !== device);
    if (this.dir) fs.rmSync(path.join(this.dir, device), { recursive: true, force: true });
    this.persist();
  }
}

// ---- public keys ----

/** HPKE KEM MLKEM768-X25519 (X-Wing, draft-ietf-hpke-pq) as used by Argo (tools/argo/bpsec.go). */
export const ARGO_KEM_ID = 0x647a;
const SIGN_KEY_BYTES = 32;
const KEM_KEY_BYTES = 1216;

export interface DeviceKeys {
  sign: string; // base64 Ed25519 public key
  kem_id: number;
  kem: string; // base64 HPKE public key
  publishedAt: string;
}

const b64len = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return -1;
  return Buffer.from(value, "base64").length;
};

/** Validates a published key set; anything else in the body is ignored. */
export function parseKeys(body: unknown, now = new Date()): DeviceKeys | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.kem_id !== ARGO_KEM_ID || b64len(b.sign) !== SIGN_KEY_BYTES || b64len(b.kem) !== KEM_KEY_BYTES) return null;
  return { sign: b.sign as string, kem_id: ARGO_KEM_ID, kem: b.kem as string, publishedAt: now.toISOString() };
}

/** Same code `argo keys` prints: SHA-256 over CBOR [sign, kem_id, kem], first 10 bytes in groups of four. */
export function keyFingerprint(k: Pick<DeviceKeys, "sign" | "kem_id" | "kem">): string {
  const sign = Buffer.from(k.sign, "base64");
  const kem = Buffer.from(k.kem, "base64");
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    throw new Error("key too large");
  };
  const cbor = Buffer.concat([Buffer.from([0x83]), head(2, sign.length), sign, head(0, k.kem_id), head(2, kem.length), kem]);
  const hex = createHash("sha256").update(cbor).digest("hex").slice(0, 20).toUpperCase();
  return hex.match(/.{4}/g)!.join(" ");
}
