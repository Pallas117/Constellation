import { createHash } from "node:crypto";
import { once } from "node:events";
import { promisify } from "node:util";
import { brotliCompress, brotliCompressSync, constants as zlibConstants, gzip, gzipSync } from "node:zlib";
import type { Request, Response } from "express";

const JSON_TYPE = "application/json; charset=utf-8";

/** Above this many items a list response is streamed instead of built as one string. */
export const STREAM_MIN_ITEMS = 2000;
const CHUNK_ITEMS = 500;

/**
 * Sends `{...head, [field]: items}` with the same bytes `res.json` would produce, but writes it
 * in chunks of items and yields to the event loop between chunks. The 24 h feed backfill is
 * ~56 MB of JSON: as one `res.json` it blocked every other request for ~0.5 s and held the whole
 * string (plus a SHA-1 ETag pass over it) in memory. Small lists still go through `res.json`.
 * `items` must not change while it is being sent (pass a copy, e.g. a slice of the buffer).
 */
export async function sendJsonList(
  res: Response,
  head: Record<string, unknown>,
  field: string,
  items: readonly unknown[],
): Promise<void> {
  if (items.length < STREAM_MIN_ITEMS) {
    res.json({ ...head, [field]: items });
    return;
  }
  const headJson = JSON.stringify(head);
  const open = `${headJson.length > 2 ? `${headJson.slice(0, -1)},` : "{"}${JSON.stringify(field)}:[`;
  res.setHeader("Content-Type", JSON_TYPE);
  if (!(await write(res, open))) return;
  for (let i = 0; i < items.length; i += CHUNK_ITEMS) {
    const chunk = JSON.stringify(items.slice(i, i + CHUNK_ITEMS)).slice(1, -1);
    if (!(await write(res, i === 0 ? chunk : `,${chunk}`))) return;
  }
  res.end("]}");
}

/** Writes one chunk, waiting for drain or yielding a turn; false once the client has gone. */
async function write(res: Response, text: string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (!res.write(text)) {
    await Promise.race([once(res, "drain"), once(res, "close")]);
  } else {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return !res.destroyed && !res.writableEnded;
}

interface MapLike {
  timestamp: string;
  nside: number;
  grid: unknown;
  harmonics: unknown;
}

let cachedMap: { timestamp: string; nside: number; grid: unknown; harmonics: unknown; json: string; hash: string } | null = null;

const shortHash = (text: string) => createHash("sha1").update(text).digest("base64url").slice(0, 20);

/**
 * The aurora map reply: the same bytes as `JSON.stringify({ projection, requestedTimestamp, ...map })`
 * plus a strong ETag. The ~5 MB grid is serialised and hashed once per distinct map (the worker
 * reuses the grid while its drivers are unchanged) instead of on every 5 s poll from every tab,
 * and a browser revalidating with If-None-Match gets a 304 instead of the 5 MB again.
 */
export function auroraMapReply(
  map: MapLike,
  projection: string,
  requestedTimestamp: string | null,
): { body: string; etag: string } {
  const c = cachedMap;
  if (
    !c ||
    c.grid !== map.grid ||
    c.harmonics !== map.harmonics ||
    c.timestamp !== map.timestamp ||
    c.nside !== map.nside
  ) {
    const json = JSON.stringify(map);
    cachedMap = { timestamp: map.timestamp, nside: map.nside, grid: map.grid, harmonics: map.harmonics, json, hash: shortHash(json) };
  }
  const { json, hash } = cachedMap!;
  const head = JSON.stringify({ projection, requestedTimestamp });
  const body = json.length > 2 ? `${head.slice(0, -1)},${json.slice(1)}` : head;
  return { body, etag: `"${hash}-${shortHash(head)}"` };
}

export type ReplyEncoding = "br" | "gzip" | "identity";

/** Below this a reply goes out uncompressed: the saving is smaller than the work. */
export const COMPRESS_MIN_BYTES = 1024;
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/**
 * Sends `value` as JSON, compressed with brotli or gzip when the client accepts it and the body is
 * at least COMPRESS_MIN_BYTES. Compression runs on the libuv thread pool, not the event loop.
 * For the paid data API: a 720-point history is 2.3 MB of JSON and 35 KB gzipped (67x, measured on
 * the live feed 2026-11-11), and egress is what an API customer costs us. Use it only for bodies
 * that hold no secrets next to attacker-chosen text (BREACH).
 * Never rejects (Express 4 doesn't catch async handlers): a body that can't be serialised gets a
 * 500, and a compression failure falls back to the uncompressed body.
 */
export async function sendJsonCompressed(req: Request, res: Response, value: unknown): Promise<void> {
  let raw: Buffer;
  try {
    raw = Buffer.from(JSON.stringify(value));
  } catch (err) {
    console.error("[json] reply could not be serialised:", err instanceof Error ? err.message : err);
    if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    return;
  }
  res.setHeader("Content-Type", JSON_TYPE);
  res.setHeader("Vary", "Accept-Encoding");
  const encoding = raw.length >= COMPRESS_MIN_BYTES ? req.acceptsEncodings("br", "gzip") : false;
  let body = raw;
  try {
    if (encoding === "br") {
      body = await brotliAsync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    } else if (encoding === "gzip") {
      body = await gzipAsync(raw, { level: 6 });
    }
  } catch (err) {
    console.error("[json] compression failed; sending uncompressed:", err instanceof Error ? err.message : err);
    body = raw;
  }
  if (res.destroyed || res.writableEnded) return;
  if (body !== raw) res.setHeader("Content-Encoding", encoding as string);
  res.setHeader("Content-Length", String(body.length));
  res.end(body);
}

/** The last compressed reply per encoding (tabs asking for br and gzip don't evict each other). */
const compressed = new Map<ReplyEncoding, { etag: string; body: Buffer }>();

/**
 * A reply body in the encoding the client accepts, compressed once per distinct reply. The aurora
 * map is ~5 MB of JSON polled every 5 s per tab: brotli (q4) sends ~0.6 MB, gzip (level 1, what
 * browsers ask for over plain HTTP) ~1.2 MB. Each encoding gets its own strong ETag.
 * The body holds no secrets, so compressing it beside the reflected query is safe (no BREACH).
 */
export function encodedReply(
  reply: { body: string; etag: string },
  encoding: ReplyEncoding,
): { body: Buffer | string; etag: string; encoding: ReplyEncoding } {
  if (encoding === "identity") return { body: reply.body, etag: reply.etag, encoding };
  const etag = `${reply.etag.slice(0, -1)}-${encoding === "br" ? "br" : "gz"}"`;
  let entry = compressed.get(encoding);
  if (entry?.etag !== etag) {
    const raw = Buffer.from(reply.body);
    const body =
      encoding === "br"
        ? brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        : gzipSync(raw, { level: 1 });
    entry = { etag, body };
    compressed.set(encoding, entry);
  }
  return { body: entry.body, etag, encoding };
}
