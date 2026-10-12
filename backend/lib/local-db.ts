import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.GAUSS_BEDROCK_DIR
  ? path.resolve(process.env.GAUSS_BEDROCK_DIR)
  : path.resolve(__dirname, "../../data/bedrock");
const TELEMETRY_FILE = path.join(DATA_DIR, "telemetry.jsonl");

export class BedrockDB {
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

  public async appendTelemetry(data: any) {
    await this.ensureDir();
    const line = JSON.stringify(data) + "\n";
    try {
      await fs.appendFile(TELEMETRY_FILE, line, "utf8");
    } catch (err) {
      console.error("[Bedrock] Append failed", err);
    }
  }

  /** Lines skipped by the last read because they were not valid JSON (e.g. a torn final write). */
  public lastSkippedLines = 0;

  /**
   * The last `limit` records, oldest first. Reads the file backwards in fixed-size chunks, so the
   * cost scales with `limit`, not with the file size (the live file grows ~17 MB/day). GAU-117.
   */
  public async getRecent(limit: number = 200): Promise<any[]> {
    await this.ensureDir();
    const lines = await readTailLines(TELEMETRY_FILE, Math.max(0, Math.floor(limit)));
    const records: any[] = [];
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
  public async getCanonicalSince(sinceMs: number, maxLines: number): Promise<any[]> {
    const recent = await this.getRecent(maxLines);
    return recent
      .filter((r) => r?.type === "canonical" && r.data && Date.parse(r.data.timestamp) >= sinceMs)
      .map((r) => r.data)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }

  public async clearOld(keepLines: number = 5000) {
    await this.ensureDir();
    try {
      const content = await fs.readFile(TELEMETRY_FILE, "utf8");
      const lines = content.trim().split("\n");
      if (lines.length > keepLines) {
        const remaining = lines.slice(lines.length - keepLines).join("\n") + "\n";
        await fs.writeFile(TELEMETRY_FILE, remaining, "utf8");
      }
    } catch (err) {
      // Ignore
    }
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
