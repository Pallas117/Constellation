/**
 * Touch ID lock for Gauss signing keys (GAU-67). Each person locks their own signing key to a
 * key in their Mac's Secure Enclave that only works after their fingerprint (Touch ID). There is
 * nothing to remember, and the key never unlocks on another Mac or for another finger.
 *
 * Locking needs no touch: an ephemeral P-256 key agrees a secret with the enclave key's public
 * half (ECDH), HKDF-SHA256 turns it into a wrapping key, and AES-256-GCM seals the signing key's
 * PKCS#8 bytes, with the header as additional data. Unlocking asks the enclave for the same secret
 * (scripts/trust/secure-enclave.swift), which it gives only after Touch ID. Every lock uses a fresh
 * ephemeral key, so no two locked files share a secret.
 *
 * Only the signing key is encrypted, never data: this is key management for signing (REG-04,
 * docs/CRYPTO_INVENTORY.md).
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createECDH, createHash, createPrivateKey, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keyIdOf } from "./signing.js";

export const TOUCH_ID_KEY_SCHEMA = "gauss.touch-id-signing-key/0.1" as const;
const HKDF_INFO = "gauss touch-id signing key";

/** A key in the Secure Enclave: its opaque blob (usable only by this Mac's enclave) and public half. */
export interface EnclaveKey {
  key: string;
  publicKey: string;
}

/** The Secure Enclave, or a stand-in for tests. `derive` returns the ECDH secret with `peer`. */
export interface Enclave {
  create(): EnclaveKey;
  derive(key: string, peer: Buffer, reason: string): Buffer;
}

export interface TouchIdLockedKey {
  schema: typeof TOUCH_ID_KEY_SCHEMA;
  keyId: string;
  owner: string;
  enclave: EnclaveKey;
  ephemeralPublicKey: string;
  kdf: "hkdf-sha256";
  salt: string;
  cipher: "aes-256-gcm";
  lockedAt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

type Header = Omit<TouchIdLockedKey, "iv" | "tag" | "ciphertext">;

const aadOf = (h: Header) =>
  Buffer.from(
    JSON.stringify({
      schema: h.schema,
      keyId: h.keyId,
      owner: h.owner,
      enclave: { key: h.enclave.key, publicKey: h.enclave.publicKey },
      ephemeralPublicKey: h.ephemeralPublicKey,
      kdf: h.kdf,
      salt: h.salt,
      cipher: h.cipher,
      lockedAt: h.lockedAt,
    }),
    "utf8",
  );

const wrapKeyOf = (shared: Buffer, h: Header) => Buffer.from(hkdfSync("sha256", shared, Buffer.from(h.salt, "base64"), `${HKDF_INFO} ${h.keyId}`, 32));

const OWNER = /^[\p{L}\p{N} ._@'-]{1,64}$/u;

/** Lock `privateKey` for `owner` to the enclave key `enclaveKey`. Needs no touch. */
export function lockKeyToEnclave(privateKey: KeyObject, owner: string, enclaveKey: EnclaveKey, nowMs = Date.now()): TouchIdLockedKey {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("only Ed25519 signing keys are locked");
  if (!OWNER.test(owner)) throw new Error("owner: 1 to 64 letters, digits, spaces or . _ @ ' -");
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.from(enclaveKey.publicKey, "base64"));
  const header: Header = {
    schema: TOUCH_ID_KEY_SCHEMA,
    keyId: keyIdOf(privateKey),
    owner,
    enclave: { key: enclaveKey.key, publicKey: enclaveKey.publicKey },
    ephemeralPublicKey: ephemeral.getPublicKey("base64"),
    kdf: "hkdf-sha256",
    salt: randomBytes(16).toString("base64"),
    cipher: "aes-256-gcm",
    lockedAt: new Date(nowMs).toISOString(),
  };
  const wrap = wrapKeyOf(shared, header);
  const iv = randomBytes(12);
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  try {
    const cipher = createCipheriv("aes-256-gcm", wrap, iv).setAAD(aadOf(header));
    const ciphertext = Buffer.concat([cipher.update(der), cipher.final()]);
    return { ...header, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  } finally {
    shared.fill(0);
    wrap.fill(0);
    der.fill(0);
  }
}

/** The key in `locked`, after the enclave's Touch ID check. Throws "not unlocked" otherwise. */
export function unlockKeyWithEnclave(locked: TouchIdLockedKey, enclave: Enclave): KeyObject {
  const shared = enclave.derive(locked.enclave.key, Buffer.from(locked.ephemeralPublicKey, "base64"), `unlock the Gauss signing key ${locked.keyId} (${locked.owner})`);
  const wrap = wrapKeyOf(shared, locked);
  shared.fill(0);
  let der: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", wrap, Buffer.from(locked.iv, "base64")).setAAD(aadOf(locked));
    decipher.setAuthTag(Buffer.from(locked.tag, "base64"));
    der = Buffer.concat([decipher.update(Buffer.from(locked.ciphertext, "base64")), decipher.final()]);
  } catch {
    throw new Error("not unlocked: the locked file does not match its enclave key");
  } finally {
    wrap.fill(0);
  }
  try {
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519" || keyIdOf(key) !== locked.keyId) throw new Error("the locked key does not match its key id");
    return key;
  } finally {
    der.fill(0);
  }
}

const isB64 = (v: unknown, bytes?: number) => typeof v === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && (bytes === undefined || Buffer.from(v, "base64").length === bytes);

/** The Touch ID locked key in `bytes`; null for any other file; an error for a damaged one. */
export function parseTouchIdLockedKey(bytes: Buffer): TouchIdLockedKey | null {
  if (bytes[0] !== 0x7b) return null;
  let k: TouchIdLockedKey;
  try {
    k = JSON.parse(bytes.toString("utf8")) as TouchIdLockedKey;
  } catch {
    return null;
  }
  if (k?.schema !== TOUCH_ID_KEY_SCHEMA) return null;
  const ok =
    /^ed25519:[0-9a-f]{32}$/.test(String(k.keyId)) &&
    typeof k.owner === "string" &&
    OWNER.test(k.owner) &&
    isB64(k.enclave?.key) &&
    isB64(k.enclave?.publicKey, 65) &&
    isB64(k.ephemeralPublicKey, 65) &&
    k.kdf === "hkdf-sha256" &&
    isB64(k.salt, 16) &&
    k.cipher === "aes-256-gcm" &&
    !Number.isNaN(Date.parse(k.lockedAt)) &&
    isB64(k.iv, 12) &&
    isB64(k.tag, 16) &&
    isB64(k.ciphertext);
  if (!ok) throw new Error(`a damaged ${TOUCH_ID_KEY_SCHEMA} file`);
  return k;
}

const HELPER_SOURCE = fileURLToPath(new URL("../../scripts/trust/secure-enclave.swift", import.meta.url));

/** The helper binary, built from its source on first use (and again whenever the source changes). */
function helperPath(): string {
  if (process.platform !== "darwin") throw new Error("Touch ID keys need a Mac with a Secure Enclave");
  const hash = createHash("sha256").update(readFileSync(HELPER_SOURCE)).digest("hex").slice(0, 16);
  const dir = join(homedir(), "Library", "Caches", "gauss");
  const bin = join(dir, `secure-enclave-${hash}`);
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    console.error("Building the Touch ID helper (first use, a few seconds)...");
    const tmp = `${bin}.${process.pid}`;
    execFileSync("swiftc", ["-O", HELPER_SOURCE, "-o", tmp], { stdio: ["ignore", "ignore", "inherit"] });
    renameSync(tmp, bin);
  }
  return bin;
}

/** This Mac's Secure Enclave, through the helper. `derive` shows the Touch ID prompt. */
export function macEnclave(): Enclave {
  return {
    create: () => JSON.parse(execFileSync(helperPath(), ["create"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })) as EnclaveKey,
    derive: (key, peer, reason) => {
      try {
        const out = execFileSync(helperPath(), ["derive"], {
          input: JSON.stringify({ key, peer: peer.toString("base64"), reason }),
          encoding: "utf8",
          stdio: ["pipe", "pipe", "inherit"],
        });
        return Buffer.from(out.trim(), "base64");
      } catch (e) {
        throw new Error("not unlocked: Touch ID was refused or cancelled", { cause: e });
      }
    },
  };
}
