import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import express from "express";
import { auroraMapReply, encodedReply, sendJsonList, STREAM_MIN_ITEMS } from "./json-response.ts";

async function serve(app: express.Express, run: (base: string) => Promise<void>) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const point = (i: number) => ({ timestamp: new Date(1_700_000_000_000 + i * 5000).toISOString(), v: i / 3, s: 'q" ', n: null });

test("sendJsonList sends exactly the bytes res.json would, streamed or not", async () => {
  const app = express();
  app.get("/list/:n", async (req, res) => {
    const items = Array.from({ length: Number(req.params.n) }, (_, i) => point(i));
    await sendJsonList(res, { source: "memory", count: items.length }, "points", items);
  });
  await serve(app, async (base) => {
    for (const n of [0, 1, STREAM_MIN_ITEMS - 1, STREAM_MIN_ITEMS, 5_001]) {
      const items = Array.from({ length: n }, (_, i) => point(i));
      const res = await fetch(`${base}/list/${n}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(await res.text(), JSON.stringify({ source: "memory", count: n, points: items }), `n=${n}`);
    }
  });
});

const grid = Array.from({ length: 300 }, (_, i) => ({ lat: i / 7, lon: -i, probability: i % 2, energyFlux: 0.1 }));
const map = { timestamp: "2026-11-04T00:00:00.000Z", nside: 64, grid, harmonics: { l: 2, coefficients: [1, 2, 3] } };

test("auroraMapReply equals the spread reply and keys its ETag on the map and the query", () => {
  const a = auroraMapReply(map, "gsm", null);
  assert.equal(a.body, JSON.stringify({ projection: "gsm", requestedTimestamp: null, ...map }));
  assert.equal(auroraMapReply({ ...map }, "gsm", null).etag, a.etag, "a new object with the same grid keeps its ETag");
  assert.equal(auroraMapReply(map, "geo", "x").body, JSON.stringify({ projection: "geo", requestedTimestamp: "x", ...map }));
  assert.notEqual(auroraMapReply(map, "geo", null).etag, a.etag);
  assert.notEqual(auroraMapReply({ ...map, timestamp: "2026-11-04T00:01:00.000Z" }, "gsm", null).etag, a.etag);
  assert.notEqual(auroraMapReply({ ...map, grid: grid.slice(1) }, "gsm", null).etag, a.etag);
});

test("an unchanged aurora map revalidates to 304", async () => {
  const app = express();
  app.get("/map", (_req, res) => {
    const reply = auroraMapReply(map, "gsm", null);
    res.setHeader("ETag", reply.etag);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(reply.body);
  });
  await serve(app, async (base) => {
    const first = await fetch(`${base}/map`);
    const etag = first.headers.get("etag");
    assert.ok(etag);
    assert.equal(await first.text(), JSON.stringify({ projection: "gsm", requestedTimestamp: null, ...map }));
    // node:http, as a browser revalidating from its cache: fetch() adds Cache-Control: no-cache
    // to a hand-set If-None-Match, which (correctly) always gets the full reply.
    const again = await new Promise<{ status?: number; bytes: number }>((resolve, reject) => {
      http
        .get(`${base}/map`, { headers: { "if-none-match": etag } }, (res) => {
          let bytes = 0;
          res.on("data", (d: Buffer) => (bytes += d.length));
          res.on("end", () => resolve({ status: res.statusCode, bytes }));
        })
        .on("error", reject);
    });
    assert.deepEqual(again, { status: 304, bytes: 0 });
  });
});

test("encodedReply decodes to the same body, with one strong ETag per encoding", () => {
  const reply = auroraMapReply(map, "gsm", null);
  const br = encodedReply(reply, "br");
  const gz = encodedReply(reply, "gzip");
  const plain = encodedReply(reply, "identity");
  assert.equal(plain.body, reply.body);
  assert.equal(plain.etag, reply.etag);
  assert.equal(brotliDecompressSync(br.body as Buffer).toString(), reply.body);
  assert.equal(gunzipSync(gz.body as Buffer).toString(), reply.body);
  assert.equal(new Set([br.etag, gz.etag, plain.etag]).size, 3);
  assert.ok(/^"[^"]+"$/.test(br.etag) && /^"[^"]+"$/.test(gz.etag), "strong ETags");
  assert.equal(encodedReply(reply, "br").body, br.body, "compressed once, reused");
  encodedReply(reply, "gzip");
  assert.equal(encodedReply(reply, "br").body, br.body, "a gzip client does not evict the brotli copy");
});
