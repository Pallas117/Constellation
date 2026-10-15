import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { displayPath, memoryBaseUrl, memoryQuery, memoryStatus } from "./client.js";

test("only a loopback http URL reaches the memory service (it has no auth of its own)", () => {
  assert.equal(memoryBaseUrl(undefined), "http://127.0.0.1:3002", "default");
  assert.equal(memoryBaseUrl("http://localhost:3012/"), "http://localhost:3012");
  assert.equal(memoryBaseUrl("http://[::1]:3002"), "http://[::1]:3002");
  for (const bad of ["off", "", "http://example.com:3002", "http://10.0.0.5:3002", "https://127.0.0.1:3002", "http://user:pw@127.0.0.1:3002", "not a url", "http://127.0.0.1.evil.com"]) {
    assert.equal(memoryBaseUrl(bad), null, bad);
  }
});

test("source paths shown to users never reveal where the corpus lives on disk", () => {
  assert.equal(displayPath("docs/adr/0001-ccsds.md"), "docs/adr/0001-ccsds.md");
  assert.equal(displayPath("/Users/someone/corpus/public/noaa-scales.md"), "noaa-scales.md");
  assert.equal(displayPath("~/corpus/notes.md"), "notes.md");
  assert.equal(displayPath("C:\\corpus\\notes.md"), "notes.md");
  assert.equal(displayPath("public/../private/deck.md"), "deck.md");
  assert.equal(displayPath(undefined), "unknown source");
});

test("status and answers pass through only verified evidence and no local paths", async (t) => {
  let up = true;
  const server = http.createServer((req, res) => {
    if (!up) {
      res.writeHead(500).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/rag/status") {
      res.end(JSON.stringify({ ok: true, state: "nominal", dbPath: "/Users/someone/catalog.sqlite", documents: 3, chunks: 40, nodes: 12, edges: 30, lastIndexAt: "2026-10-15T01:00:00Z" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { query, top_k } = JSON.parse(body) as { query: string; top_k: number };
      res.end(
        JSON.stringify({
          ok: true,
          answer: `Conclusion: answered "${query}" with top_k=${top_k}`,
          sources: [
            { filePath: "/Users/someone/corpus/public/kp.md", chunkId: "c1", score: 0.8, sourceSha256: "ab", verified: true },
            { filePath: "public/tampered.md", chunkId: "c2", score: 0.9, verified: false },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.GAUSS_MEMORY_URL;
  process.env.GAUSS_MEMORY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    server.close();
    if (previous === undefined) delete process.env.GAUSS_MEMORY_URL;
    else process.env.GAUSS_MEMORY_URL = previous;
  });

  const status = await memoryStatus();
  assert.deepEqual(status, { available: true, state: "nominal", documents: 3, chunks: 40, nodes: 12, edges: 30, lastIndexAt: "2026-10-15T01:00:00Z" });
  assert.equal(JSON.stringify(status).includes("/Users/"), false);

  const answer = await memoryQuery("What drives Kp?", 99);
  assert.ok(answer.available);
  assert.match(answer.answer, /top_k=20/, "top_k is capped");
  assert.deepEqual(answer.sources, [{ filePath: "kp.md", chunkId: "c1", score: 0.8, sourceSha256: "ab", verified: true }], "unverified chunks are dropped");

  up = false;
  assert.deepEqual(await memoryStatus(), { available: false, reason: "Memory service error 500." });
  server.close();
  const down = await memoryQuery("anything");
  assert.equal(down.available, false);
});

test("an unconfigured memory service is reported, not faked", async (t) => {
  const previous = process.env.GAUSS_MEMORY_URL;
  process.env.GAUSS_MEMORY_URL = "off";
  t.after(() => {
    if (previous === undefined) delete process.env.GAUSS_MEMORY_URL;
    else process.env.GAUSS_MEMORY_URL = previous;
  });
  const status = await memoryStatus();
  assert.equal(status.available, false);
  assert.match(!status.available ? status.reason : "", /not configured/);
});
