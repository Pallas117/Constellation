/**
 * Gauss signing keys (PR-04a, GAU-67):
 *   npm run trust:keys -- new --out <file outside the repo> --purpose evidence-pack|release-artifact [--note <text>]
 *   npm run trust:keys -- check [--keyring <file>]
 *
 * `new` makes an Ed25519 key pair, writes the private key (PKCS#8 PEM, mode 600, never over an
 * existing file) to --out, which must be outside the repository, and prints the keyring entry for
 * its public half: add it to backend/trust/signing-keys.json and commit that before signing. The
 * private key is never printed. `check` validates the keyring and lists each key's state; it exits
 * 1 on a problem and warns when a purpose has no current key (the release check runs it).
 *
 *   npm run trust:keys -- lock --key <key file> [--out <locked file>] [--remove-plain] [--pattern-tty]
 *   npm run trust:keys -- new --lock --out <locked file> --purpose ... [--pattern-tty]
 *
 * `lock` locks a key file under a geometry pattern (backend/trust/key-lock.ts): drawn twice in a
 * one-time page with the rotating tesseract, or typed as vertex letters with --pattern-tty and over
 * SSH. It writes `<key file>.locked` (mode 600), checks that it unlocks, and with --remove-plain
 * overwrites and deletes the unlocked file. `new --lock` never writes an unlocked copy.
 */
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockKey, unlockKey, writeLockedKey, type LockedKey } from "../../backend/trust/key-lock.js";
import { patternPrompt } from "../../backend/trust/pattern-page.js";
import { KEY_PURPOSES, keyIdOf, keyringEntry, keyStatus, loadSigningKey, parseKeyring, PUBLISHED_KEYRING_PATH, type KeyPurpose } from "../../backend/trust/signing.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const terminal = args.includes("--pattern-tty");

/** Ask for a new pattern (twice) and lock `key` under it, checking that it unlocks. */
async function lockWithPattern(key: KeyObject): Promise<LockedKey> {
  let locked: LockedKey | undefined;
  const ok = await patternPrompt("lock", keyIdOf(key), { terminal })((pattern) => {
    try {
      const l = lockKey(key, pattern);
      if (keyIdOf(unlockKey(l, pattern)) !== keyIdOf(key)) return false;
      locked = l;
      return true;
    } catch {
      return false;
    }
  });
  if (!ok || !locked) return fail("not locked: no pattern was set");
  return locked;
}

if (args[0] === "new") {
  const out = opt("--out");
  const purpose = opt("--purpose") as KeyPurpose | undefined;
  if (!out || !purpose || !KEY_PURPOSES.includes(purpose)) {
    console.error(`usage: npm run trust:keys -- new --out <file outside the repo> --purpose ${KEY_PURPOSES.join("|")} [--note <text>] [--lock [--pattern-tty]]`);
    process.exit(2);
  }
  const inRepo = (p: string) => {
    const rel = relative(root, p);
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  const target = resolve(out);
  if (inRepo(target)) fail(`${out} is inside the repository: keep signing keys outside it (docs/EVIDENCE_SIGNING.md)`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (inRepo(join(realpathSync(dirname(target)), basename(target)))) fail(`${out} is inside the repository: keep signing keys outside it`);
  const { privateKey } = generateKeyPairSync("ed25519");
  const locked = args.includes("--lock") ? await lockWithPattern(privateKey) : undefined;
  try {
    if (locked) writeLockedKey(target, locked);
    else writeFileSync(target, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  } catch {
    fail(`${out} already exists or can't be written: a key file is never overwritten`);
  }
  console.log(JSON.stringify(keyringEntry(privateKey, [purpose], Date.now(), opt("--note")), null, 2));
  console.error(
    `Private key written to ${target} (mode 600${locked ? ", locked under your pattern" : ""}; never commit, copy into chat or paste it anywhere). ` +
      "Add the entry above to backend/trust/signing-keys.json and commit it, then set retiredAt on the key it replaces.",
  );
} else if (args[0] === "lock") {
  const keyPath = opt("--key");
  if (!keyPath) {
    console.error("usage: npm run trust:keys -- lock --key <key file> [--out <locked file>] [--remove-plain] [--pattern-tty]");
    process.exit(2);
  }
  const key = (() => {
    try {
      return loadSigningKey(keyPath, root);
    } catch (e) {
      return fail(`not locked: ${(e as Error).message}`);
    }
  })();
  const target = resolve(opt("--out") ?? `${keyPath}.locked`);
  const rel = relative(root, target);
  if (!rel.startsWith("..") && !isAbsolute(rel)) fail(`${target} is inside the repository: keep signing keys outside it`);
  const locked = await lockWithPattern(key);
  try {
    writeLockedKey(target, locked);
  } catch {
    fail(`${target} already exists or can't be written: a key file is never overwritten`);
  }
  console.error(`${keyIdOf(key)} locked in ${target} (mode 600). Sign with --sign-key ${target}.`);
  if (args.includes("--remove-plain")) {
    // Overwrite, then delete. On an SSD (APFS) the old blocks can survive until reused; FileVault keeps them encrypted.
    const real = realpathSync(keyPath);
    const fd = openSync(real, "r+");
    try {
      writeSync(fd, randomBytes(statSync(real).size));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    unlinkSync(real);
    console.error(`The unlocked file ${keyPath} was overwritten and deleted.`);
  } else {
    console.error(`The unlocked file ${keyPath} is still there: delete it once you have signed with the locked one (or rerun with --remove-plain).`);
  }
} else if (args[0] === "check") {
  const path = opt("--keyring") ?? PUBLISHED_KEYRING_PATH;
  const { keyring, problems } = parseKeyring(readFileSync(path, "utf8"));
  for (const k of keyring.keys) {
    const dates = [`from ${k.validFrom}`, k.retiredAt && `retired ${k.retiredAt}`, k.revokedAt && `revoked ${k.revokedAt}`].filter(Boolean).join(", ");
    console.log(`${k.keyId}  ${k.purposes.join(",")}  ${keyStatus(k)} (${dates})${k.note ? `  ${k.note}` : ""}`);
  }
  for (const p of KEY_PURPOSES) {
    if (!keyring.keys.some((k) => k.purposes.includes(p) && keyStatus(k) === "current")) console.warn(`WARN: no current ${p} key: make one with npm run trust:keys -- new before signing`);
  }
  if (problems.length) fail(`${path}: FAILED\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  console.log(`${path}: OK, ${keyring.keys.length} key(s)`);
} else {
  console.error(`usage: npm run trust:keys -- new --out <file outside the repo> --purpose ${KEY_PURPOSES.join("|")} [--note <text>]`);
  console.error("       npm run trust:keys -- lock --key <key file> [--out <locked file>] [--remove-plain] [--pattern-tty]");
  console.error("       npm run trust:keys -- check [--keyring <file>]");
  process.exit(2);
}
