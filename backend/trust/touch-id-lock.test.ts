import assert from "node:assert/strict";
import { createECDH, generateKeyPairSync, randomBytes, type ECDH } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openSigningKey, writeLockedKey } from "./key-lock.js";
import { keyIdOf } from "./signing.js";
import { lockKeyToEnclave, parseTouchIdLockedKey, unlockKeyWithEnclave, type Enclave, type TouchIdLockedKey } from "./touch-id-lock.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * A software stand-in for one person's Secure Enclave: the same P-256 agreement, with the "blob"
 * naming a key it holds. The real one (scripts/trust/secure-enclave.swift) also asks for Touch ID.
 */
function softwareEnclave(): Enclave & { touches: number } {
  const keys = new Map<string, ECDH>();
  return {
    touches: 0,
    create() {
      const k = createECDH("prime256v1");
      k.generateKeys();
      const blob = randomBytes(24).toString("base64");
      keys.set(blob, k);
      return { key: blob, publicKey: k.getPublicKey("base64") };
    },
    derive(key, peer) {
      this.touches++;
      const k = keys.get(key);
      if (!k) throw new Error("not unlocked: this enclave does not hold that key");
      return k.computeSecret(peer);
    },
  };
}

test("touch id lock: a key locked to its owner's Secure Enclave key unlocks only through that key; another person's enclave, a changed header or a damaged file fails, and the key is never stored in the clear (GAU-67)", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const josh = softwareEnclave();
  const locked = lockKeyToEnclave(privateKey, "Josh", josh.create());
  assert.equal(josh.touches, 0, "locking needs no touch");
  const text = JSON.stringify(locked);
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  assert.ok(!/PRIVATE KEY/.test(text));
  assert.ok(!Buffer.from(locked.ciphertext, "base64").equals(der), "the key bytes are sealed, not copied");
  assert.equal(locked.owner, "Josh");

  assert.equal(keyIdOf(unlockKeyWithEnclave(locked, josh)), keyIdOf(privateKey));
  assert.equal(josh.touches, 1, "each unlock is one touch");
  const again = lockKeyToEnclave(privateKey, "Josh", josh.create());
  assert.notEqual(again.ephemeralPublicKey, locked.ephemeralPublicKey, "every lock agrees a fresh secret");

  const merve = softwareEnclave();
  assert.throws(() => unlockKeyWithEnclave(locked, merve), /not unlocked/, "another person's enclave can't unlock it");
  const mervesKey = merve.create();
  assert.throws(() => unlockKeyWithEnclave({ ...locked, enclave: mervesKey }, merve), /not unlocked/, "swapping in another enclave key fails");
  const other = keyIdOf(generateKeyPairSync("ed25519").privateKey);
  const changed: TouchIdLockedKey[] = [
    { ...locked, owner: "Mallory" },
    { ...locked, keyId: other },
    { ...locked, lockedAt: "2026-01-01T00:00:00.000Z" },
    { ...locked, salt: randomBytes(16).toString("base64") },
    { ...locked, ciphertext: Buffer.from(Buffer.from(locked.ciphertext, "base64").map((b, i) => (i === 5 ? b ^ 1 : b))).toString("base64") },
  ];
  for (const k of changed) assert.throws(() => unlockKeyWithEnclave(k, josh), /not unlocked|does not match/);
  assert.throws(() => lockKeyToEnclave(privateKey, "", josh.create()), /owner/);
  assert.throws(() => lockKeyToEnclave(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey, "Josh", josh.create()), /Ed25519/);

  assert.deepEqual(parseTouchIdLockedKey(Buffer.from(text)), locked);
  assert.equal(parseTouchIdLockedKey(Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" }))), null, "a PEM file is not a Touch ID file");
  assert.equal(parseTouchIdLockedKey(Buffer.from(JSON.stringify({ schema: "gauss.locked-signing-key/0.1" }))), null, "nor is a pattern-locked one");
  for (const bad of [{ ...locked, iv: "AAAA" }, { ...locked, ephemeralPublicKey: "AAAA" }, { ...locked, owner: "<script>" }])
    assert.throws(() => parseTouchIdLockedKey(Buffer.from(JSON.stringify(bad))), /damaged/);

  const dir = mkdtempSync(join(tmpdir(), "gauss-touch-id-"));
  try {
    const file = join(dir, "evidence.locked");
    writeLockedKey(file, locked);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    let patternAsked = false;
    const prompt = async () => (patternAsked = true);
    assert.equal(keyIdOf(await openSigningKey(file, repoRoot, prompt, josh)), locked.keyId, "the signing tools unlock it through the enclave");
    assert.equal(patternAsked, false, "a Touch ID file never asks for a pattern");
    await assert.rejects(openSigningKey(file, repoRoot, prompt, merve), /not unlocked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
