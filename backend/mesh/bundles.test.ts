import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import type { AuthenticatedRequest, AuthRole } from "../auth.js";
import { BundleStore, crc32c, crcX25, keyFingerprint, parseKeys, parsePrimary } from "./bundles.js";
import { createMeshRouters } from "./router.js";
import { MeshStore, parseLink, parseReport } from "./store.js";

// Golden bundles written by Argo's Go encoder (tools/argo/fixtures_test.go).
const FIXTURES = path.resolve("tools/argo/testdata/bundles");
interface Manifest {
  bundles: Array<{ file: string; valid: boolean; id?: string; source?: string; dest?: string; createdMs?: number; seq?: number; lifetimeMs?: number }>;
  keys: Array<{ node: string; sign: string; kem_id: number; kem: string; fingerprint: string }>;
}
const manifest = JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8")) as Manifest;
const fixture = (file: string) => readFileSync(path.join(FIXTURES, file));
const keyOf = (node: string) => manifest.keys.find((k) => k.node === node)!;
// Fixtures were created 2026-10-23 09:00 UTC with a 48 h lifetime.
const FIXTURE_NOW = new Date("2026-10-23T10:00:00Z");

test("CRC check values match the standard ones", () => {
  const msg = new TextEncoder().encode("123456789");
  assert.equal(crc32c(msg), 0xe3069283);
  assert.equal(crcX25(msg), 0x906e);
});

test("the hub parses Argo's bundles to the same ids, endpoints and times as Argo", () => {
  for (const f of manifest.bundles) {
    if (!f.valid) {
      assert.throws(() => parsePrimary(fixture(f.file)), /CRC/, f.file);
      continue;
    }
    const p = parsePrimary(fixture(f.file));
    assert.equal(p.id, f.id, f.file);
    assert.equal(p.source, f.source, f.file);
    assert.equal(p.dest, f.dest, f.file);
    assert.equal(p.createdMs, f.createdMs, f.file);
    assert.equal(p.lifetimeMs, f.lifetimeMs, f.file);
  }
  assert.throws(() => parsePrimary(Buffer.from([0x82, 0x01, 0x02])), /not a BPv7 bundle/);
  assert.throws(() => parsePrimary(fixture("file-chunk.bundle").subarray(0, 20)));
});

test("key fingerprints match `argo keys`, and only well-formed key sets are accepted", () => {
  for (const k of manifest.keys) {
    assert.equal(keyFingerprint(k), k.fingerprint);
    assert.ok(parseKeys(k));
  }
  const k = keyOf("judith");
  assert.equal(parseKeys({ ...k, kem_id: 0x20 }), null, "only the post-quantum hybrid KEM");
  assert.equal(parseKeys({ ...k, sign: k.sign.slice(8) }), null, "Ed25519 keys are 32 bytes");
  assert.equal(parseKeys({ ...k, kem: "not base64!" }), null);
});

test("link stability is range-checked; a bad window drops the whole block", () => {
  const w = { observedSec: 86400, availability: 0.843, outages: 24, downSec: 13565, mttrP50Sec: 180, mttrP95Sec: 3780, mtbfSec: 3034 };
  assert.deepEqual(parseLink({ d1: w, d7: { ...w, observedSec: 604800 } })?.d1, w);
  assert.equal(parseLink({ d1: w }), undefined);
  assert.equal(parseLink({ d1: { ...w, availability: 1.5 }, d7: w }), undefined);
  assert.equal(parseLink({ d1: { ...w, outages: -2 }, d7: w }), undefined);
  const notMeasured = { observedSec: 0, availability: -1, outages: 0, downSec: 0, mttrP50Sec: -1, mttrP95Sec: -1, mtbfSec: -1 };
  assert.ok(parseLink({ d1: notMeasured, d7: notMeasured }));
  const report = parseReport({ class: "OK", checkedAt: "2026-10-23T09:00:00Z", link: { d1: w, d7: w, extra: "dropped" } });
  assert.equal(JSON.stringify(report?.link).includes("extra"), false);
});

test("the mailbox enforces source, destination, lifetime and dedup, and keeps tombstones", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gauss-bundles-"));
  try {
    let now = FIXTURE_NOW;
    const store = new BundleStore(dir, () => now);
    const enrolled = (d: string) => d === "judith" || d === "ground-1";
    const chunk = fixture("file-chunk.bundle");
    const id = manifest.bundles.find((b) => b.file === "file-chunk.bundle")!.id!;

    assert.deepEqual(store.put("ground-1", chunk, enrolled), { ok: false, status: 403, error: "Bundle source is not this device" });
    assert.equal(store.put("judith", chunk, () => false).ok, false, "unknown destination");
    assert.equal(store.put("judith", fixture("bad-crc.bundle"), enrolled).ok, false);
    assert.deepEqual(store.put("judith", chunk, enrolled), { ok: true, status: 201, id, duplicate: false });
    assert.deepEqual(store.put("judith", chunk, enrolled), { ok: true, status: 200, id, duplicate: true });
    assert.equal(statSync(path.join(dir, "ground-1", `${id}.bundle`)).mode & 0o777, 0o600);

    assert.equal(store.list("judith").length, 0, "only the destination sees it");
    assert.deepEqual(store.list("ground-1").map((b) => [b.id, b.from]), [[id, "judith"]]);
    assert.equal(store.get("judith", id), null);
    assert.deepEqual(store.get("ground-1", id), chunk);
    assert.deepEqual(store.status("judith", [id]), { [id]: "queued" });
    assert.deepEqual(store.status("ground-1", [id]), { [id]: "unknown" }, "status is only for the sender");
    assert.equal(store.queueStats().get("ground-1")?.queued, 1);

    assert.equal(store.ack("judith", id), false);
    assert.equal(store.ack("ground-1", id), true);
    assert.deepEqual(store.status("judith", [id]), { [id]: "picked-up" });
    assert.deepEqual(store.put("judith", chunk, enrolled), { ok: true, status: 200, id, duplicate: true }, "a tombstone stops redelivery");

    // A restart reads the index back.
    const again = new BundleStore(dir, () => now);
    assert.deepEqual(again.status("judith", [id]), { [id]: "picked-up" });

    now = new Date("2026-10-26T00:00:00Z"); // past the 48 h lifetime
    again.sweep();
    assert.deepEqual(again.status("judith", [id]), { [id]: "unknown" });
    assert.equal(again.put("judith", chunk, enrolled).ok, false, "expired bundles are refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withHub(fn: (base: string) => Promise<void>) {
  const mesh = createMeshRouters(new MeshStore(null), new BundleStore(null, () => FIXTURE_NOW));
  const app = express();
  app.use(express.json());
  app.use("/api/mesh", mesh.agent);
  app.use("/api", (req: AuthenticatedRequest, _res, next) => {
    const role = req.header("x-test-role") as AuthRole | undefined;
    if (role) req.auth = { userId: req.header("x-test-user") ?? `u-${role}`, email: null, role, rawRoles: [role], token: "t" };
    next();
  });
  app.use("/api/mesh", mesh.ui);
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mesh`);
  } finally {
    server.close();
  }
}

const post = (body: unknown, token: string, type = "application/json") => ({
  method: "POST",
  headers: { "content-type": type, authorization: `Bearer ${token}` },
  body: type === "application/json" ? JSON.stringify(body) : (body as Buffer),
});

test("two devices exchange a sealed bundle and a receipt through the hub routes", async () => {
  await withHub(async (base) => {
    const enroll = async (name: string, user: string) => {
      const res = await fetch(`${base}/devices`, { method: "POST", headers: { "content-type": "application/json", "x-test-role": "staff", "x-test-user": user }, body: JSON.stringify({ name }) });
      return ((await res.json()) as { token: string }).token;
    };
    const judith = await enroll("judith", "u-josh");
    const ground = await enroll("ground-1", "u-ops");
    const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

    // Keys: first publish wins; the same again is fine; a different set is refused.
    assert.equal((await fetch(`${base}/keys`, post(keyOf("judith"), judith))).status, 201);
    assert.equal((await fetch(`${base}/keys`, post(keyOf("judith"), judith))).status, 200);
    assert.equal((await fetch(`${base}/keys`, post(keyOf("ground-1"), judith))).status, 400, "node must be the caller");
    const { node: _n, ...groundKeys } = keyOf("ground-1");
    assert.equal((await fetch(`${base}/keys`, post({ ...groundKeys, node: "judith" }, judith))).status, 409, "a different key set never replaces the first");
    assert.equal((await fetch(`${base}/keys`, post(groundKeys, ground))).status, 201);
    assert.equal((await fetch(`${base}/keys`, post(keyOf("judith"), ground))).status, 400);
    const dir = (await (await fetch(`${base}/directory`, auth(ground))).json()) as { keys: Array<{ node: string }> };
    assert.deepEqual(dir.keys.map((k) => k.node), ["ground-1", "judith"]);
    assert.equal((await fetch(`${base}/directory`)).status, 401);

    // judith → ground-1
    const chunk = fixture("file-chunk.bundle");
    const id = manifest.bundles.find((b) => b.file === "file-chunk.bundle")!.id!;
    assert.equal((await fetch(`${base}/bundles`, post(chunk, ground, "application/octet-stream"))).status, 403, "ground-1 can't upload judith's bundle");
    assert.equal((await fetch(`${base}/bundles`, post(chunk, judith, "application/octet-stream"))).status, 201);
    const list = (await (await fetch(`${base}/bundles`, auth(ground))).json()) as { bundles: Array<{ id: string; from: string }> };
    assert.deepEqual(list.bundles.map((b) => [b.id, b.from]), [[id, "judith"]]);
    assert.equal((await fetch(`${base}/bundles/${id}`, auth(judith))).status, 404, "only the destination downloads");
    const got = await fetch(`${base}/bundles/${id}`, auth(ground));
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), chunk);
    assert.equal((await fetch(`${base}/bundles/${id}`, { method: "DELETE", ...auth(ground) })).status, 204);
    const status = (await (await fetch(`${base}/bundles/status`, post({ ids: [id] }, judith))).json()) as { status: Record<string, string> };
    assert.equal(status.status[id], "picked-up");
    assert.equal((await fetch(`${base}/bundles/status`, post({ ids: ["../etc"] }, judith))).status, 400);

    // The relay column on /mesh shows counts only.
    await fetch(`${base}/bundles`, post(fixture("receipt.bundle"), ground, "application/octet-stream"));
    const devices = (await (await fetch(`${base}/devices`, { headers: { "x-test-role": "operator" } })).json()) as {
      devices: Array<{ name: string; relay: { queued: number }; keyFingerprint?: string }>;
    };
    const j = devices.devices.find((d) => d.name === "judith")!;
    assert.equal(j.relay.queued, 1);
    assert.equal(j.keyFingerprint, keyOf("judith").fingerprint);
    assert.equal(JSON.stringify(devices).includes(keyOf("judith").kem), false, "public keys stay off the page; fingerprints are enough");

    // Revoking a device drops its mailbox and what it sent.
    assert.equal((await fetch(`${base}/devices/judith`, { method: "DELETE", headers: { "x-test-role": "admin" } })).status, 204);
    assert.equal((await fetch(`${base}/bundles`, auth(judith))).status, 401);
  });
});
