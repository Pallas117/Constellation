// Argo session ratchet (REQ-SEC-007). The vectors below were computed with Python's `cryptography` and
// hashlib/hmac (an implementation independent of Node's), from the fixed inputs shown; X25519 is
// RFC 7748 section 6.1. Run alone: node --import tsx --import ./backend/test-setup.ts --test backend/argo-session/ratchet.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_SKIP,
  RootError,
  ackTag,
  clientHello,
  contextDigest,
  createServerSigner,
  deriveFirstChainKey,
  messageKey,
  nextChainKey,
  requestTag,
  serverRoot,
  transcriptHash,
  verifyHybrid,
  type ClientChain,
  type RootBinding,
} from "./ratchet.ts";
import { argoSessionRatchetEnabled, createSessionStore, parseStepHeader } from "./sessions.ts";
import { createPrivateKey, createPublicKey, diffieHellman } from "node:crypto";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fill = (byte: number, n: number) => Buffer.alloc(n, byte);

const V = {
  ck0: "8137cb2cc2cd6f17eb4d9b9eb9d89409d0d24d5a71d68569425bccf41b564ac69cff14cfe478a40d34e6947aabcb0d0d",
  ck1: "e97ee4ed9a392a210971f9e6a7d4760e13d9e94a631d3553153bca397ae68b06d4a19ed820df948dfb73de8da9fc24b3",
  ctxHotspot: "f95a3539ee3ba1c38ee69f2df90845ef298a18d0998837407a32c92afa8e3ffa",
  ctxEmpty: "117aa502d13feaf7fea6e956b4efc2c02dd462d8e13c2d52fc0bf167b6ff47f0",
  mk0: "44ffea92553701b67246c403aea37a1a513064c44bc13a5756531478c3169d50d387aeaf69bb7543abf7050e1df5df25",
  tag0: "f3c28e1fe7854c5db4459adadacbcc032a1b440fbce65d51aca1a24194e1b994",
  ack0: "4ad79d52e029137f9bead23fa893a3822a69a8ec2774d01d5dd01d5ef78d8ace",
  transcript: "22deb89ddeee4cb384c242cec0c2da110930afe03fd38988fa63711e25bb1da93e641bdc62db6bbfcf38a7cda12a72db",
};

const IP = "203.0.113.7"; // RFC 5737 documentation address
const TOKEN = "cookie-session-token-a";

function binding(handle = "handle-0123456789abcdef"): RootBinding {
  return { handle, userId: "user-1", signedInAt: 1_764_000_000_000, passkeyCredentialId: null, device: { ip: IP } };
}

function rooted(options: Parameters<typeof createSessionStore>[0] = {}, handle = "handle-0123456789abcdef") {
  const signer = createServerSigner();
  const hello = clientHello();
  const b = binding(handle);
  const { response, chainKey } = serverRoot(b, hello.request, signer);
  const client = hello.finish(b, response, signer.publicKeys);
  const store = createSessionStore(options);
  store.add({ handle, userId: "user-1", token: TOKEN, device: { ip: IP }, chainKey });
  return { store, client, signer, handle };
}

function send(store: ReturnType<typeof createSessionStore>, client: ClientChain, path = "/api/ops/status", net: string | null = "wifi", over: Partial<{ token: string; ip: string; method: string; path: string; net: string | null }> = {}) {
  const { headers } = client.next("GET", path, net);
  const parsed = parseStepHeader(headers["x-argo-session"]);
  assert.ok(parsed);
  return store.step({
    handle: parsed.handle,
    step: parsed.step,
    tag: parsed.tag,
    token: over.token ?? TOKEN,
    device: { ip: over.ip ?? IP },
    net: over.net !== undefined ? over.net : (headers["x-argo-net"] ?? null),
    method: over.method ?? "GET",
    path: over.path ?? path,
  });
}

describe("argo session ratchet (REQ-SEC-007)", () => {
  it("argo ratchet: derivations match the independent test vectors", () => {
    const ck0 = deriveFirstChainKey(fill(1, 32), fill(2, 32), fill(3, 48));
    assert.equal(hex(ck0), V.ck0);
    assert.equal(hex(nextChainKey(ck0)), V.ck1);
    assert.equal(hex(contextDigest({ net: "hotspot" })), V.ctxHotspot);
    assert.equal(hex(contextDigest({ net: "Hotspot " })), V.ctxHotspot, "context is normalised");
    assert.equal(hex(contextDigest({ net: "bad/value" })), V.ctxEmpty, "an invalid context is unknown, not an error");
    const mk0 = messageKey(ck0, contextDigest({ net: "hotspot" }));
    assert.equal(hex(mk0), V.mk0);
    assert.equal(hex(requestTag(mk0, 0, "get", "/api/argo/status?x=1")), V.tag0);
    assert.equal(hex(ackTag(mk0, 0)), V.ack0);
    const t = transcriptHash(binding(), fill(4, 1184), fill(5, 32), fill(6, 1088), fill(7, 32), { mldsa65: fill(8, 1952), ed25519: fill(9, 32) });
    assert.equal(hex(t), V.transcript);
  });

  it("argo ratchet: X25519 in Node matches RFC 7748 section 6.1", () => {
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex")]);
    const alice = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    const bob = createPublicKey({ key: Buffer.from("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f", "hex"), format: "raw-public", asymmetricKeyType: "x25519" });
    assert.equal(hex(diffieHellman({ privateKey: alice, publicKey: bob })), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
  });

  it("argo ratchet: seeded server keys are deterministic and both signatures are required", () => {
    const seeds = { mldsa65: fill(0x11, 32), ed25519: fill(0x22, 32) };
    const a = createServerSigner(seeds);
    const b = createServerSigner(seeds);
    assert.equal(hex(a.publicKeys.mldsa65), hex(b.publicKeys.mldsa65));
    assert.equal(hex(a.publicKeys.ed25519), hex(b.publicKeys.ed25519));
    assert.equal(a.publicKeys.mldsa65.length, 1952);
    const msg = Buffer.from("statement");
    const sig = a.sign(msg);
    assert.equal(verifyHybrid(a.publicKeys, msg, sig), true);
    const other = createServerSigner().sign(msg);
    assert.equal(verifyHybrid(a.publicKeys, msg, { mldsa65: sig.mldsa65, ed25519: other.ed25519 }), false);
    assert.equal(verifyHybrid(a.publicKeys, msg, { mldsa65: other.mldsa65, ed25519: sig.ed25519 }), false);
  });

  it("argo ratchet root: hybrid ML-KEM-768 + X25519 gives both sides the same chain at sign-in", () => {
    const signer = createServerSigner();
    const hello = clientHello();
    const { response, chainKey } = serverRoot(binding(), hello.request, signer);
    assert.equal(response.kemCiphertext.length, 1088);
    const client = hello.finish(binding(), response, signer.publicKeys);
    const store = createSessionStore();
    store.add({ handle: client.handle, userId: "user-1", token: TOKEN, device: { ip: IP }, chainKey });
    assert.equal(send(store, client).ok, true);
  });

  it("argo ratchet root: a pinned client refuses other server keys, a bad signature, or another binding", () => {
    const signer = createServerSigner();
    const hello = clientHello();
    const { response } = serverRoot(binding(), hello.request, signer);
    assert.throws(() => hello.finish(binding(), response, createServerSigner().publicKeys), RootError);
    const badSig = { ...response, signature: { ...response.signature, ed25519: Buffer.alloc(64) } };
    assert.throws(() => hello.finish(binding(), badSig, signer.publicKeys), RootError);
    assert.throws(() => hello.finish({ ...binding(), device: { ip: "198.51.100.9" } }, response, signer.publicKeys), /Transcript mismatch/);
  });

  it("argo ratchet root: malformed key shares are refused with fixed messages", () => {
    const signer = createServerSigner();
    const hello = clientHello();
    assert.throws(() => serverRoot(binding(), { kem: Buffer.alloc(10), x25519: hello.request.x25519 }, signer), /1184 bytes/);
    assert.throws(() => serverRoot(binding(), { kem: hello.request.kem, x25519: Buffer.alloc(31) }, signer), /32 bytes/);
    assert.throws(() => serverRoot(binding(), { kem: hello.request.kem, x25519: Buffer.alloc(32) }, signer), RootError, "all-zero X25519 share");
  });

  it("argo ratchet step: each request has a fresh key, and a step is accepted once", () => {
    const { store, client, handle } = rooted();
    const first = client.next("GET", "/api/ops/status", "wifi");
    const second = client.next("GET", "/api/ops/status", "wifi");
    assert.notEqual(first.headers["x-argo-session"].split(".")[2], second.headers["x-argo-session"].split(".")[2]);
    const p = parseStepHeader(first.headers["x-argo-session"]);
    assert.ok(p);
    const args = { handle, step: p.step, tag: p.tag, token: TOKEN, device: { ip: IP }, net: "wifi", method: "GET", path: "/api/ops/status" };
    assert.equal(store.step(args).ok, true);
    assert.deepEqual(store.step(args), { ok: false, reason: "replay", userId: "user-1" });
    assert.equal(store.has(handle), false, "a replay kills the ratchet");
  });

  it("argo ratchet step: out-of-order steps inside the window pass once; a reordered replay or a step past the window fails", () => {
    const { store, client, handle } = rooted();
    const a = client.next("GET", "/api/a", null);
    const b = client.next("GET", "/api/b", null);
    const pa = parseStepHeader(a.headers["x-argo-session"]);
    const pb = parseStepHeader(b.headers["x-argo-session"]);
    assert.ok(pa && pb);
    const base = { handle, token: TOKEN, device: { ip: IP }, net: null, method: "GET" };
    assert.equal(store.step({ ...base, step: pb.step, tag: pb.tag, path: "/api/b" }).ok, true);
    assert.equal(store.skippedCount(handle), 1);
    assert.equal(store.step({ ...base, step: pa.step, tag: pa.tag, path: "/api/a" }).ok, true);
    assert.equal(store.skippedCount(handle), 0, "forward secrecy: no chain key is kept for a used step");
    assert.equal(store.step({ ...base, step: pa.step, tag: pa.tag, path: "/api/a" }).ok, false);

    const far = rooted();
    for (let i = 0; i < MAX_SKIP; i += 1) far.client.next("GET", "/api/x", null);
    assert.deepEqual(send(far.store, far.client, "/api/x", null), { ok: false, reason: "too-far", userId: "user-1" });
  });

  it("argo ratchet step: a step tagged for another context, method or path fails and kills the session", () => {
    for (const over of [{ net: "hotspot" }, { method: "POST" }, { path: "/api/ops/other" }]) {
      const { store, client, handle } = rooted();
      assert.equal(send(store, client, "/api/ops/status", "wifi", over).ok, false, JSON.stringify(over));
      assert.equal(store.has(handle), false);
    }
  });

  it("argo ratchet step: a copied step from another cookie session or address fails, as does a malformed step", () => {
    const one = rooted();
    assert.deepEqual(send(one.store, one.client, "/api/ops/status", "wifi", { token: "stolen-elsewhere" }), { ok: false, reason: "other-session", userId: "user-1" });
    const two = rooted();
    assert.deepEqual(send(two.store, two.client, "/api/ops/status", "wifi", { ip: "198.51.100.9" }), { ok: false, reason: "device-changed", userId: "user-1" });
    const three = rooted();
    assert.equal(three.store.step({ handle: three.handle, step: -1, tag: Buffer.alloc(32), token: TOKEN, device: { ip: IP }, net: null, method: "GET", path: "/" }).ok, false);
    assert.equal(parseStepHeader("short.1.abc"), null);
    assert.equal(parseStepHeader(undefined), null);
  });

  it("argo ratchet death: idle and age timeouts, revocation by token and by user, and the per-user cap", () => {
    let t = 0;
    const idle = rooted({ now: () => t, idleMs: 1_000 });
    t = 1_001;
    assert.deepEqual(send(idle.store, idle.client), { ok: false, reason: "no-session" });

    t = 0;
    const aged = rooted({ now: () => t, idleMs: 1_000, maxAgeMs: 2_500 });
    for (t = 900; t <= 2_700; t += 900) {
      const r = send(aged.store, aged.client);
      assert.equal(r.ok, t <= 2_500, `at ${t} ms`);
    }

    const byToken = rooted();
    assert.deepEqual(byToken.store.killToken(TOKEN), [byToken.handle]);
    assert.deepEqual(send(byToken.store, byToken.client), { ok: false, reason: "no-session" });

    const byUser = rooted();
    assert.deepEqual(byUser.store.killUser("user-1"), [byUser.handle]);
    assert.equal(send(byUser.store, byUser.client).ok, false);

    const capped = createSessionStore({ maxPerUser: 2 });
    for (let i = 0; i < 3; i += 1) capped.add({ handle: `handle-cap-000000000${i}`, userId: "user-1", token: `t${i}`, device: { ip: IP }, chainKey: Buffer.alloc(48, i) });
    assert.equal(capped.size(), 2);
    assert.equal(capped.has("handle-cap-0000000000"), false, "the oldest goes first");
  });

  it("argo ratchet flag: off unless ARGO_SESSION_RATCHET=on", () => {
    assert.equal(argoSessionRatchetEnabled({}), false);
    assert.equal(argoSessionRatchetEnabled({ ARGO_SESSION_RATCHET: "1" }), false);
    assert.equal(argoSessionRatchetEnabled({ ARGO_SESSION_RATCHET: " ON " }), true);
  });
});
