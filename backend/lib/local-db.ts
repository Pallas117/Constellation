import crypto from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createGunzip, createGzip } from "node:zlib";
import type { CanonicalSpaceWeatherPoint } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.GAUSS_BEDROCK_DIR
  ? path.resolve(process.env.GAUSS_BEDROCK_DIR)
  : path.resolve(__dirname, "../../data/bedrock");
const TELEMETRY_FILE = path.join(DATA_DIR, "telemetry.jsonl");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");

/** Lines archiveOld leaves in the live file by default: readers ask for up to 20,000 (server.ts). */
export const DEFAULT_KEEP_LINES = 30_000;

/** One line of telemetry.jsonl: a `type` tag, usually a `timestamp`, and that record's fields. */
export interface BedrockRecord {
  type: string;
  timestamp?: string;
  data?: unknown;
  [field: string]: unknown;
}

export class BedrockDB {
  /** Directory holding telemetry.jsonl (its volume's free space is a TPM). */
  readonly dataDir = DATA_DIR;

  private initialized = false;

  private async ensureDir() {
    if (this.initialized) return;
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      this.initialized = true;
    } catch (err) {
      console.error("[Bedrock] Failed to create data directory", err);
    }
  }

  /** Appends that failed (disk full, permissions, ...) since start; surfaced, never swallowed. GAU-121. */
  public failedWrites = 0;

  /** Best-effort append for fire-and-forget callers: never rejects; failures are counted and logged. */
  public async appendTelemetry(data: BedrockRecord) {
    try {
      await this.appendTelemetryStrict(data);
    } catch {
      // already counted and logged
    }
  }

  /**
   * Append that rejects on failure, for callers that must know (the ingest loop records it as a
   * persist-stage error instead of reporting the write as ok). GAU-121.
   */
  public async appendTelemetryStrict(data: BedrockRecord) {
    const line = JSON.stringify(data) + "\n";
    try {
      // Joins the lock queue synchronously, so lines land in call order and an append waits while
      // archiveOld swaps the file instead of being lost.
      await this.locked(async () => {
        await this.ensureDir();
        await fs.appendFile(TELEMETRY_FILE, line, "utf8");
      });
    } catch (err) {
      this.failedWrites += 1;
      console.error("[Bedrock] Append failed", err);
      throw err;
    }
  }

  /** Serialises appends and archiving (every writer to telemetry.jsonl is in this process). */
  private chain: Promise<unknown> = Promise.resolve();
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Lines skipped by the last read because they were not valid JSON (e.g. a torn final write). */
  public lastSkippedLines = 0;

  /**
   * The last `limit` records, oldest first. Reads the file backwards in fixed-size chunks, so the
   * cost scales with `limit`, not with the file size (the live file grows ~17 MB/day). GAU-117.
   */
  public async getRecent(limit: number = 200): Promise<BedrockRecord[]> {
    await this.ensureDir();
    const lines = await readTailLines(TELEMETRY_FILE, Math.max(0, Math.floor(limit)));
    const records: BedrockRecord[] = [];
    let skipped = 0;
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        skipped += 1; // one bad line must not hide the rest
      }
    }
    this.lastSkippedLines = skipped;
    return records;
  }

  /** Canonical points measured at or after `sinceMs`, oldest first, from at most `maxLines` lines. */
  public async getCanonicalSince(sinceMs: number, maxLines: number): Promise<CanonicalSpaceWeatherPoint[]> {
    const recent = await this.getRecent(maxLines);
    return recent
      .filter((r) => r?.type === "canonical" && r.data)
      .map((r) => r.data as CanonicalSpaceWeatherPoint)
      .filter((p) => Date.parse(p.timestamp) >= sinceMs)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }

  /**
   * Moves all but the newest `keepLines` lines into a verified, compressed archive (GAU-157).
   * Nothing is deleted unless its archive was written and checked first. Not scheduled anywhere:
   * the retention period is an owner decision.
   */
  public async archiveOld(keepLines: number = DEFAULT_KEEP_LINES): Promise<ArchiveResult> {
    return this.locked(async () => {
      await this.ensureDir();
      return archiveTelemetry(TELEMETRY_FILE, ARCHIVE_DIR, keepLines);
    });
  }

  /** @deprecated Use archiveOld: the old version deleted history without an archive. */
  public async clearOld(keepLines: number = DEFAULT_KEEP_LINES): Promise<ArchiveResult> {
    return this.archiveOld(keepLines);
  }
}

export interface ArchiveResult {
  archivedLines: number;
  keptLines: number;
  /** Absolute path of the .jsonl.gz archive, or null when there was nothing to archive. */
  archive: string | null;
  manifest: ArchiveManifest | null;
}

/** Fixity and provenance for one archive (CCSDS/OAIS style). Holds no record contents. */
export interface ArchiveManifest {
  format: "gauss-telemetry-archive/1";
  source: string;
  created_at: string;
  lines: number;
  raw_bytes: number;
  raw_sha256: string;
  gzip_bytes: number;
  gzip_sha256: string;
  first_timestamp: string | null;
  last_timestamp: string | null;
}

function recordTime(line: string): string | null {
  try {
    const r = JSON.parse(line);
    const t = r?.timestamp ?? r?.data?.timestamp;
    return typeof t === "string" && !Number.isNaN(Date.parse(t)) ? t : null;
  } catch {
    return null;
  }
}

async function write(stream: WriteStream | NodeJS.WritableStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain");
}

async function finish(stream: WriteStream): Promise<void> {
  stream.end();
  await once(stream, "close");
}

function lines(file: string) {
  return createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
}

async function sha256OfStream(input: NodeJS.ReadableStream): Promise<{ sha: string; bytes: number }> {
  const h = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of input) {
    h.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha: h.digest("hex"), bytes };
}

/**
 * Streams `file` twice (count, then split), writing all but the newest `keepLines` lines to a
 * gzip archive plus a manifest in `archiveDir`, verifies the archive decompresses to exactly what
 * was removed, then atomically replaces `file` with the kept tail. Memory stays flat at any file
 * size. On any failure the live file is left untouched and partial outputs are removed.
 * The caller must stop other writers meanwhile (BedrockDB holds its append lock).
 */
export async function archiveTelemetry(file: string, archiveDir: string, keepLines: number): Promise<ArchiveResult> {
  const keep = Math.max(0, Math.floor(keepLines));
  let total = 0;
  try {
    for await (const line of lines(file)) if (line) total += 1;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { archivedLines: 0, keptLines: 0, archive: null, manifest: null };
    throw err;
  }
  if (total <= keep) return { archivedLines: 0, keptLines: total, archive: null, manifest: null };

  const toArchive = total - keep;
  await fs.mkdir(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const partGz = path.join(archiveDir, `.telemetry-${stamp}.jsonl.gz.part`);
  const partTail = `${file}.archiving-${process.pid}`;
  try {
    const gzip = createGzip();
    const gzOut = createWriteStream(partGz, { mode: 0o600 });
    const gzDone = (async () => {
      gzip.pipe(gzOut);
      await once(gzOut, "close");
    })();
    const tailOut = createWriteStream(partTail, { mode: 0o644 });
    const raw = crypto.createHash("sha256");
    let rawBytes = 0;
    let first: string | null = null;
    let last: string | null = null;
    let seen = 0;
    for await (const line of lines(file)) {
      if (!line) continue;
      const text = line + "\n";
      if (seen < toArchive) {
        raw.update(text);
        rawBytes += Buffer.byteLength(text);
        const t = recordTime(line);
        if (t) {
          first ??= t;
          last = t;
        }
        await write(gzip, text);
      } else {
        await write(tailOut, text);
      }
      seen += 1;
    }
    gzip.end();
    await gzDone;
    await finish(tailOut);
    const rawSha = raw.digest("hex");

    // Verify before deleting anything: the archive must decompress to exactly the removed lines.
    const check = await sha256OfStream(createReadStream(partGz).pipe(createGunzip()));
    if (check.sha !== rawSha || check.bytes !== rawBytes) throw new Error("archive verification failed");
    const gz = await sha256OfStream(createReadStream(partGz));

    const safe = (t: string | null) => (t ?? "unknown").replace(/[:.]/g, "-");
    const base = path.join(archiveDir, `telemetry-${safe(first)}_${safe(last)}-${stamp}.jsonl.gz`);
    const manifest: ArchiveManifest = {
      format: "gauss-telemetry-archive/1",
      source: path.basename(file),
      created_at: new Date().toISOString(),
      lines: toArchive,
      raw_bytes: rawBytes,
      raw_sha256: rawSha,
      gzip_bytes: gz.bytes,
      gzip_sha256: gz.sha,
      first_timestamp: first,
      last_timestamp: last,
    };
    await fs.rename(partGz, base);
    await fs.writeFile(`${base}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(partTail, file); // atomic: readers see the old file or the new one, never half
    return { archivedLines: toArchive, keptLines: keep, archive: base, manifest };
  } catch (err) {
    await fs.rm(partGz, { force: true });
    await fs.rm(partTail, { force: true });
    throw err;
  }
}

const TAIL_CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * Last `maxLines` non-empty lines of a file, in order, without reading the whole file. Works on
 * bytes and splits on "\n", so multi-byte UTF-8 characters are never cut across chunks.
 */
export async function readTailLines(file: string, maxLines: number): Promise<string[]> {
  if (maxLines <= 0) return [];
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return []; // file might not exist yet
  }
  try {
    const { size } = await handle.stat();
    let pos = size;
    let carry: Buffer = Buffer.alloc(0);
    const out: string[] = [];
    while (pos > 0 && out.length < maxLines) {
      const len = Math.min(TAIL_CHUNK_BYTES, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      await handle.read(chunk, 0, len, pos);
      let buf = Buffer.concat([chunk, carry]);
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0 && out.length < maxLines; i -= 1) {
        if (buf[i] !== NEWLINE) continue;
        const line = buf.subarray(i + 1, end).toString("utf8").trim();
        if (line) out.push(line);
        end = i;
      }
      carry = Buffer.from(buf.subarray(0, end));
      buf = Buffer.alloc(0);
    }
    if (pos === 0 && out.length < maxLines) {
      const first = carry.toString("utf8").trim();
      if (first) out.push(first);
    }
    return out.reverse();
  } finally {
    await handle.close();
  }
}

export const bedrock = new BedrockDB();
