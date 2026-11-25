/**
 * Argo session ratchet, v0. R&D, UNREVIEWED, off by default (ARGO_SESSION_RATCHET=on, see sessions.ts);
 * nothing mounts it yet. Design note: docs/security/argo-session-ratchet.md.
 *
 * It AUTHENTICATES requests; it does NOT encrypt them. Confidentiality comes from TLS only.
 *
 * The protocol is ours; every primitive is a standard one from Node 26's built-in OpenSSL:
 * ML-KEM-768 (FIPS 203), X25519 (RFC 7748), ML-DSA-65 (FIPS 204), Ed25519, HKDF-SHA-384, HMAC-SHA-384.
 *
 * 1. Root, at sign-in. The client sends an ephemeral ML-KEM-768 encapsulation key and an X25519 share.
 *    The server encapsulates, answers with its own X25519 share and signs the transcript with ML-DSA-65
 *    AND Ed25519. root = HKDF-SHA-384(ss_mlkem || ss_x25519, salt = transcript). Hybrid: the root holds
 *    while either half holds. The transcript commits to the user, the sign-in time and the client
 *    address the server observed.
 *    TODO(passkey binding): commit to the passkey assertion once passkey sign-in is on main; the field
 *    is in the transcript already (empty until then).
 * 2. Step, per request. Symmetric chain: ck(n+1) = HMAC(ck(n), 0x02). Request n is tagged with
 *    mk(n) = HMAC(ck(n), 0x01 || context digest), so the key changes with every request and with the
 *    declared context. The server keeps the next chain key and a bounded window of skipped ones, each
 *    usable once.
 * 3. Death. A failed step, replay, wrong context, address change, idle or age timeout, or revocation
 *    deletes the state. Used keys are zeroed (forward secrecy within the chain).
 *    TODO(duress): a duress sign-in should kill the ratchet and open a decoy; see the design note.
 *    TODO(encrypted channel): an AEAD channel keyed from the chain is not built; see the design note.
 */
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  decapsulate,
  diffieHellman,
  encapsulate,
  generateKeyPairSync,
  hkdfSync,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

export const SUITE = "argo-session/v0 mlkem768+x25519 hkdf-sha384 hmac-sha384 mldsa65+ed25519";
export const MLKEM768_PUBLIC_BYTES = 1184;
export const MLKEM768_CIPHERTEXT_BYTES = 1088;
export const X25519_PUBLIC_BYTES = 32;
export const TAG_BYTES = 32;
/** How far ahead of the next expected step a request may be (concurrent fetches); also the skipped-key cap. */
export const MAX_SKIP = 64;

const ROOT_INFO = Buffer.from(`${SUITE} root`);
const CHAIN_LABEL = Buffer.from([0x02]);
const MESSAGE_LABEL = Buffer.from([0x01]);

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
export const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");

/** Length-prefixed concatenation (u32 big-endian length, then bytes), so no field can shift into its neighbour. */
export function lp(...parts: Array<Uint8Array | string>): Buffer {
  const out: Buffer[] = [];
  for (const p of parts) {
    const b = typeof p === "string" ? Buffer.from(p, "utf8") : Buffer.from(p);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    out.push(len, b);
  }
  return Buffer.concat(out);
}

const sha384 = (b: Uint8Array): Buffer => createHash("sha384").update(b).digest();
const hmac = (key: Uint8Array, ...data: Uint8Array[]): Buffer => {
  const h = createHmac("sha384", key);
  for (const d of data) h.update(d);
  return h.digest();
};

/** What the server observed when the root was made; a step from anywhere else kills the session. */
export interface DeviceFacts {
  /** Client address from CyberTiger's extractClientIp, never req.ip. */
  ip: string;
}

export interface RootBinding {
  handle: string;
  userId: string;
  /** Sign-in time, ms since the Unix epoch. */
  signedInAt: number;
  /** TODO(passkey binding): the passkey credential id; null until passkey sign-in is on main. */
  passkeyCredentialId: string | null;
  device: DeviceFacts;
}

export interface ServerPublicKeys {
  mldsa65: Uint8Array;
  ed25519: Uint8Array;
}

export function transcriptHash(
  binding: RootBinding,
  clientKem: Uint8Array,
  clientX: Uint8Array,
  kemCiphertext: Uint8Array,
  serverX: Uint8Array,
  serverKeys: ServerPublicKeys,
): Buffer {
  return sha384(
    lp(
      SUITE,
      binding.handle,
      binding.userId,
      String(binding.signedInAt),
      binding.passkeyCredentialId ?? "",
      binding.device.ip,
      clientKem,
      clientX,
      kemCiphertext,
      serverX,
      serverKeys.mldsa65,
      serverKeys.ed25519,
    ),
  );
}

/** root = HKDF-SHA-384(ss_mlkem || ss_x25519, salt = transcript, info = SUITE + " root", 48 bytes); ck0 = HMAC(root, "chain"). */
export function deriveFirstChainKey(ssKem: Uint8Array, ssX: Uint8Array, transcript: Uint8Array): Buffer {
  const root = Buffer.from(hkdfSync("sha384", Buffer.concat([ssKem, ssX]), transcript, ROOT_INFO, 48));
  const ck0 = hmac(root, Buffer.from("chain"));
  root.fill(0);
  return ck0;
}

export const nextChainKey = (ck: Uint8Array): Buffer => hmac(ck, CHAIN_LABEL);

/**
 * The declared context as bytes. Today only a network class (hotspot, wifi, relay...), declared by the
 * client: it binds the key to what the client says, it proves nothing about where the client is.
 * Server-observed facts (the address) are pinned separately in DeviceFacts.
 */
export function contextDigest(context: { net?: string | null }): Buffer {
  return createHash("sha256").update(lp("ctx/v0", normaliseNet(context.net))).digest();
}

/** Lowercase [a-z0-9-]{1,24}; anything else is "" (unknown). */
export function normaliseNet(net: string | null | undefined): string {
  const n = (net ?? "").trim().toLowerCase();
  return /^[a-z0-9-]{1,24}$/.test(n) ? n : "";
}

export function messageKey(ck: Uint8Array, ctx: Uint8Array): Buffer {
  return hmac(ck, MESSAGE_LABEL, ctx);
}

/** The request tag binds step, method and path (with query). Bodies are not covered; they ride TLS. */
export function requestTag(mk: Uint8Array, step: number, method: string, path: string): Buffer {
  return hmac(mk, lp("req", String(step), method.toUpperCase(), path)).subarray(0, TAG_BYTES);
}

/** The server's answer tag, so the client knows the other end still holds the chain. */
export function ackTag(mk: Uint8Array, step: number): Buffer {
  return hmac(mk, lp("ack", String(step))).subarray(0, TAG_BYTES);
}

export function tagsEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------------------------
// Server signing keys: hybrid ML-DSA-65 + Ed25519; both signatures must verify.

export interface ServerSigner {
  publicKeys: { mldsa65: Buffer; ed25519: Buffer };
  sign(message: Uint8Array): { mldsa65: Buffer; ed25519: Buffer };
}

/** Per-boot keys by default; seeds (32 bytes each) only for test vectors. */
export function createServerSigner(seeds?: { mldsa65: Uint8Array; ed25519: Uint8Array }): ServerSigner {
  let pqPriv: KeyObject;
  let edPriv: KeyObject;
  if (seeds) {
    pqPriv = createPrivateKey({ key: Buffer.from(seeds.mldsa65), format: "raw-seed", asymmetricKeyType: "ml-dsa-65" });
    edPriv = createPrivateKey({ key: Buffer.from(seeds.ed25519), format: "raw-private", asymmetricKeyType: "ed25519" });
  } else {
    pqPriv = generateKeyPairSync("ml-dsa-65").privateKey;
    edPriv = generateKeyPairSync("ed25519").privateKey;
  }
  return {
    publicKeys: {
      mldsa65: createPublicKey(pqPriv).export({ format: "raw-public" }) as Buffer,
      ed25519: createPublicKey(edPriv).export({ format: "raw-public" }) as Buffer,
    },
    sign: (message) => ({ mldsa65: sign(null, message, pqPriv), ed25519: sign(null, message, edPriv) }),
  };
}

export function verifyHybrid(publicKeys: ServerPublicKeys, message: Uint8Array, signature: { mldsa65: Uint8Array; ed25519: Uint8Array }): boolean {
  try {
    const pq = createPublicKey({ key: Buffer.from(publicKeys.mldsa65), format: "raw-public", asymmetricKeyType: "ml-dsa-65" });
    const ed = createPublicKey({ key: Buffer.from(publicKeys.ed25519), format: "raw-public", asymmetricKeyType: "ed25519" });
    return verify(null, message, pq, signature.mldsa65) && verify(null, message, ed, signature.ed25519);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Root, server side.

export interface RootRequest {
  kem: Uint8Array; // ML-KEM-768 encapsulation key, raw 1184 bytes
  x25519: Uint8Array; // raw 32 bytes
}

export interface RootResponse {
  suite: string;
  handle: string;
  kemCiphertext: Buffer;
  serverX25519: Buffer;
  serverKeys: { mldsa65: Buffer; ed25519: Buffer };
  transcript: Buffer;
  signature: { mldsa65: Buffer; ed25519: Buffer };
}

/** Messages are fixed strings, safe to return to the client. */
export class RootError extends Error {}

export function serverRoot(binding: RootBinding, request: RootRequest, signer: ServerSigner): { response: RootResponse; chainKey: Buffer } {
  if (request.kem.length !== MLKEM768_PUBLIC_BYTES) throw new RootError("ML-KEM-768 key must be 1184 bytes");
  if (request.x25519.length !== X25519_PUBLIC_BYTES) throw new RootError("X25519 share must be 32 bytes");
  let kemKey: KeyObject;
  let clientX: KeyObject;
  try {
    kemKey = createPublicKey({ key: Buffer.from(request.kem), format: "raw-public", asymmetricKeyType: "ml-kem-768" });
    clientX = createPublicKey({ key: Buffer.from(request.x25519), format: "raw-public", asymmetricKeyType: "x25519" });
  } catch {
    throw new RootError("Malformed key share");
  }
  let enc: { sharedKey: Buffer; ciphertext: Buffer };
  try {
    enc = encapsulate(kemKey); // OpenSSL runs the FIPS 203 encapsulation-key check
  } catch {
    throw new RootError("Malformed key share");
  }
  const eph = generateKeyPairSync("x25519");
  let ssX: Buffer;
  try {
    ssX = diffieHellman({ privateKey: eph.privateKey, publicKey: clientX }); // OpenSSL refuses an all-zero result
  } catch {
    enc.sharedKey.fill(0);
    throw new RootError("Low-order X25519 share");
  }
  if (ssX.every((b) => b === 0)) {
    enc.sharedKey.fill(0);
    throw new RootError("Low-order X25519 share");
  }
  const serverX25519 = eph.publicKey.export({ format: "raw-public" }) as Buffer;
  const transcript = transcriptHash(binding, request.kem, request.x25519, enc.ciphertext, serverX25519, signer.publicKeys);
  const chainKey = deriveFirstChainKey(enc.sharedKey, ssX, transcript);
  enc.sharedKey.fill(0);
  ssX.fill(0);
  return {
    chainKey,
    response: {
      suite: SUITE,
      handle: binding.handle,
      kemCiphertext: enc.ciphertext,
      serverX25519,
      serverKeys: signer.publicKeys,
      transcript,
      signature: signer.sign(transcript),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reference client (Node, used by the tests). A browser client needs ML-KEM in WebCrypto or a reviewed
// library; the Argo (Go) client has crypto/mlkem and X25519 in the standard library, ML-DSA not yet.

export interface ClientHello {
  request: RootRequest;
  finish(binding: RootBinding, response: RootResponse, pinned?: ServerPublicKeys): ClientChain;
}

export function clientHello(): ClientHello {
  const kem = generateKeyPairSync("ml-kem-768");
  const x = generateKeyPairSync("x25519");
  const request = {
    kem: kem.publicKey.export({ format: "raw-public" }) as Buffer,
    x25519: x.publicKey.export({ format: "raw-public" }) as Buffer,
  };
  return {
    request,
    finish(binding, response, pinned) {
      if (pinned && (!tagsEqual(Buffer.from(pinned.mldsa65), response.serverKeys.mldsa65) || !tagsEqual(Buffer.from(pinned.ed25519), response.serverKeys.ed25519))) {
        throw new RootError("Server keys differ from the pinned keys");
      }
      const transcript = transcriptHash(binding, request.kem, request.x25519, response.kemCiphertext, response.serverX25519, response.serverKeys);
      if (!tagsEqual(transcript, response.transcript)) throw new RootError("Transcript mismatch");
      if (!verifyHybrid(pinned ?? response.serverKeys, transcript, response.signature)) throw new RootError("Server signature does not verify");
      const ssKem = decapsulate(kem.privateKey, response.kemCiphertext);
      const serverX = createPublicKey({ key: response.serverX25519, format: "raw-public", asymmetricKeyType: "x25519" });
      const ssX = diffieHellman({ privateKey: x.privateKey, publicKey: serverX });
      const ck = deriveFirstChainKey(ssKem, ssX, transcript);
      ssKem.fill(0);
      ssX.fill(0);
      return new ClientChain(response.handle, ck);
    },
  };
}

/** Client side of the chain: one step per request. */
export class ClientChain {
  private step = 0;
  readonly handle: string;
  private ck: Buffer;
  constructor(handle: string, ck: Buffer) {
    this.handle = handle;
    this.ck = ck;
  }

  /** Headers for the next request. `net` is the declared network class (hotspot, wifi, relay, offline...). */
  next(method: string, path: string, net?: string | null): { headers: Record<string, string>; step: number; tag: Buffer } {
    const step = this.step;
    const mk = messageKey(this.ck, contextDigest({ net }));
    const tag = requestTag(mk, step, method, path);
    mk.fill(0);
    const old = this.ck;
    this.ck = nextChainKey(this.ck);
    old.fill(0);
    this.step += 1;
    const headers: Record<string, string> = { "x-argo-session": `${this.handle}.${step}.${b64u(tag)}` };
    const n = normaliseNet(net);
    if (n) headers["x-argo-net"] = n;
    return { headers, step, tag };
  }
}
