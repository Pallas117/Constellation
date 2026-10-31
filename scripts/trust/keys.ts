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
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KEY_PURPOSES, keyringEntry, keyStatus, parseKeyring, PUBLISHED_KEYRING_PATH, type KeyPurpose } from "../../backend/trust/signing.js";

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

if (args[0] === "new") {
  const out = opt("--out");
  const purpose = opt("--purpose") as KeyPurpose | undefined;
  if (!out || !purpose || !KEY_PURPOSES.includes(purpose)) {
    console.error(`usage: npm run trust:keys -- new --out <file outside the repo> --purpose ${KEY_PURPOSES.join("|")} [--note <text>]`);
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
  try {
    writeFileSync(target, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  } catch {
    fail(`${out} already exists or can't be written: a key file is never overwritten`);
  }
  console.log(JSON.stringify(keyringEntry(privateKey, [purpose], Date.now(), opt("--note")), null, 2));
  console.error(
    `Private key written to ${target} (mode 600; never commit, copy into chat or paste it anywhere). ` +
      "Add the entry above to backend/trust/signing-keys.json and commit it, then set retiredAt on the key it replaces.",
  );
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
  console.error("       npm run trust:keys -- check [--keyring <file>]");
  process.exit(2);
}
