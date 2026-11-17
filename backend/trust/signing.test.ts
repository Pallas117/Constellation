import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyEvidencePack, type EvidencePack } from "./evidence.js";
import { renderEvidencePdf } from "./evidence-pdf.js";
import { clone, packFromStoredInputs, rehashPack, rehashRecord, relink } from "./fixtures/evidence-pack.js";
import {
  keyIdOf,
  keyringEntry,
  KEYRING_SCHEMA,
  loadSigningKey,
  PACK_SIGNATURE_TYPE,
  parseKeyring,
  PUBLISHED_KEYRING_PATH,
  signFile,
  signPack,
  verifyFileSignature,
  verifyPackSignature,
  type FileSignature,
  type Keyring,
  type KeyringEntry,
  type KeyPurpose,
  type PackSignature,
} from "./signing.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ring = (...keys: KeyringEntry[]): Keyring => ({ schema: KEYRING_SCHEMA, keys });
function newKey(purposes: KeyPurpose[] = ["evidence-pack"], validFromMs = T0) {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, entry: keyringEntry(privateKey, purposes, validFromMs) };
}
/** A full rewrite: a record changed and every hash in the pack recomputed to match. */
const rewrite = (p: EvidencePack) => {
  const forged = clone(p);
  forged.records[0].inference.confidence = 0.5;
  rehashRecord(forged.records[0]);
  relink(forged);
  rehashPack(forged);
  return forged;
};

test("signing: a signed pack verifies against the keyring without changing its pack hash; changing a record, the signature, the key id or the signing time fails (GAU-67)", async () => {
  const { pack } = await packFromStoredInputs();
  const a = newKey();
  const keyring = ring(a.entry);
  const signed = signPack(pack, a.privateKey, keyring, T0 + DAY);
  assert.equal(signed.packHash, pack.packHash, "signing does not change the pack hash, so chained packs stay chained");
  assert.deepEqual(verifyEvidencePack(signed), []);
  assert.deepEqual(verifyPackSignature(signed, keyring), { problems: [], notes: [], key: a.entry });
  assert.deepEqual({ ...signed.signature, value: "" }, { type: PACK_SIGNATURE_TYPE, algorithm: "Ed25519", keyId: a.entry.keyId, signedAt: iso(T0 + DAY), value: "" });
  assert.match(renderEvidencePdf(signed).toString("latin1"), new RegExp(`\\(${a.entry.keyId}\\) Tj`), "the PDF names the signing key");

  const doesNotVerify = (p: EvidencePack, keys = keyring) => assert.match(verifyPackSignature(p, keys).problems.join("\n"), /the signature does not verify with key ed25519:[0-9a-f]{32}: the pack or its signature was changed/);
  const edited = clone(signed);
  edited.records[0].inference.confidence = 0.5;
  assert.match(verifyEvidencePack(edited).join("\n"), /record 1 \(tr_\w+\) was changed/);
  doesNotVerify(edited);

  const forged = rewrite(signed);
  assert.deepEqual(verifyEvidencePack(forged), [], "every hash recomputed: integrity alone can't tell");
  doesNotVerify(forged);

  const flipped = clone(signed);
  const bytes = Buffer.from(flipped.signature!.value, "base64");
  bytes[10] ^= 1;
  flipped.signature!.value = bytes.toString("base64");
  doesNotVerify(flipped);
  const truncated = clone(signed);
  truncated.signature!.value = truncated.signature!.value.slice(0, 40);
  doesNotVerify(truncated);

  const b = newKey();
  const otherKey = clone(signed);
  otherKey.signature!.keyId = b.entry.keyId;
  doesNotVerify(otherKey, ring(a.entry, b.entry));
  const unknownKey = clone(signed);
  unknownKey.signature!.keyId = `ed25519:${"0".repeat(32)}`;
  assert.deepEqual(verifyPackSignature(unknownKey, keyring).problems, [`signed by key ed25519:${"0".repeat(32)}, which is not in the keyring`]);

  const moved = clone(signed);
  moved.signature!.signedAt = iso(T0 + 2 * DAY);
  doesNotVerify(moved);

  const stripped = clone(signed);
  stripped.signature = null;
  assert.deepEqual(verifyEvidencePack(stripped), [], "stripping the signature leaves an intact but unsigned pack");
  assert.deepEqual(verifyPackSignature(stripped, keyring).problems, ["the pack is not signed, so nothing shows who made it (integrity only)"]);

  // Someone else's key: refused for signing, and its signature is not accepted.
  const mallory = newKey();
  assert.throws(() => signPack(pack, mallory.privateKey, keyring, T0 + DAY), /key ed25519:\w+ is not in the keyring/);
  const resignedForged = signPack(rewrite(pack), mallory.privateKey, ring(mallory.entry), T0 + DAY);
  assert.match(verifyPackSignature(resignedForged, keyring).problems.join("\n"), /which is not in the keyring/);
  assert.throws(() => signPack(edited, a.privateKey, keyring, T0 + DAY), /Not signing a pack that does not verify/);
});

test("signing: key rotation: a pack signed before its key was retired verifies and says the key is retired; after retirement, or by a revoked key, it fails (GAU-67)", async () => {
  const { pack } = await packFromStoredInputs();
  const old = newKey();
  const before = signPack(pack, old.privateKey, ring(old.entry), T0 + DAY);
  const RETIRED = T0 + 10 * DAY;
  const next = newKey(["evidence-pack"], RETIRED);
  const rotated = ring({ ...old.entry, retiredAt: iso(RETIRED) }, next.entry);

  const check = verifyPackSignature(before, rotated);
  assert.deepEqual(check.problems, []);
  assert.deepEqual(check.notes, [
    `key ${old.entry.keyId} was retired on 2026-10-11T00:00:00.000Z (rotated out). This signature was made on 2026-10-02T00:00:00.000Z, before that, so it stands; newer ones use the current key.`,
  ]);

  assert.throws(() => signPack(pack, old.privateKey, rotated, RETIRED + DAY), /is retired: sign with a current key/);
  assert.throws(() => signPack(pack, next.privateKey, rotated, T0 + DAY), /is not yet valid: sign with a current key/);
  // The old key signing after its retirement (say, a machine with a stale keyring) is refused on checking.
  const late = signPack(pack, old.privateKey, ring(old.entry), RETIRED + DAY);
  assert.match(verifyPackSignature(late, rotated).problems.join("\n"), /signed 2026-10-12T00:00:00.000Z, after key ed25519:\w+ was retired \(2026-10-11T00:00:00.000Z\)/);
  const fresh = signPack(pack, next.privateKey, rotated, RETIRED + DAY);
  assert.deepEqual(verifyPackSignature(fresh, rotated), { problems: [], notes: [], key: next.entry });

  const revoked = ring({ ...old.entry, retiredAt: iso(RETIRED), revokedAt: iso(RETIRED + 2 * DAY) }, next.entry);
  assert.match(verifyPackSignature(before, revoked).problems.join("\n"), /key ed25519:\w+ was revoked on 2026-10-13T00:00:00.000Z, so nothing it signed can be trusted/);
  const resigned = signPack(before, next.privateKey, revoked, RETIRED + 3 * DAY);
  assert.deepEqual(verifyPackSignature(resigned, revoked).problems, [], "re-signing with the current key replaces the revoked signature");
  assert.equal(resigned.packHash, pack.packHash);
});

test("signing: release files get a detached signature; a changed byte fails, and pack and release keys and signatures can't stand in for each other (GAU-67)", async () => {
  const { pack } = await packFromStoredInputs();
  const release = newKey(["release-artifact"]);
  const packKey = newKey(["evidence-pack"]);
  const keyring = ring(release.entry, packKey.entry);
  const archive = Buffer.from("gauss-v0.1.0.tar.gz (test bytes)");
  const sig = signFile(archive, "gauss-v0.1.0.tar.gz", release.privateKey, keyring, T0 + DAY);
  assert.deepEqual(verifyFileSignature(archive, "gauss-v0.1.0.tar.gz", sig, keyring), { problems: [], notes: [], key: release.entry });
  assert.deepEqual(verifyFileSignature(archive, "renamed.tar.gz", sig, keyring).notes, ["signed as gauss-v0.1.0.tar.gz, checked as renamed.tar.gz"]);

  const changed = Buffer.from(archive);
  changed[0] ^= 1;
  assert.equal(verifyFileSignature(changed, "gauss-v0.1.0.tar.gz", sig, keyring).problems[0], "gauss-v0.1.0.tar.gz is not the file that was signed (its SHA-256 or size differs)");
  const relabelled = { ...sig, file: { ...sig.file, sha256: "0".repeat(64) } };
  assert.match(verifyFileSignature(archive, "gauss-v0.1.0.tar.gz", relabelled, keyring).problems.join("\n"), /the signature does not verify/);

  assert.throws(() => signFile(archive, "x", packKey.privateKey, keyring, T0 + DAY), /is not for release-artifact signatures/);
  assert.throws(() => signPack(pack, release.privateKey, keyring, T0 + DAY), /is not for evidence-pack signatures/);
  const signedPack = signPack(pack, packKey.privateKey, keyring, T0 + DAY);
  assert.match(verifyFileSignature(archive, "x", signedPack.signature as unknown as FileSignature, keyring).problems[0], /not a release-artifact signature/);
  const asPack = { ...pack, signature: { ...sig, type: PACK_SIGNATURE_TYPE } as unknown as PackSignature };
  assert.match(verifyPackSignature(asPack, keyring).problems.join("\n"), /the signature does not verify[\s\S]*is not for evidence-pack signatures/);
});

test("signing keys: the keyring refuses private key material, a key id that is not its key's fingerprint and bad dates; a key file must be outside the repository and readable only by its owner (GAU-67)", () => {
  const a = newKey();
  assert.deepEqual(parseKeyring(JSON.stringify(ring(a.entry))).problems, []);
  assert.match(a.entry.keyId, /^ed25519:[0-9a-f]{32}$/);
  assert.equal(keyIdOf(a.privateKey), a.entry.keyId);
  const pem = a.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const problems = (keys: unknown[]) => parseKeyring(JSON.stringify({ schema: KEYRING_SCHEMA, keys })).problems.join("\n");
  assert.match(problems([{ ...a.entry, note: pem }]), /the keyring holds private key material/);
  assert.match(problems([{ ...a.entry, keyId: newKey().entry.keyId }]), /keyId is not the fingerprint of its public key/);
  assert.match(problems([a.entry, a.entry]), /listed twice/);
  assert.match(problems([{ ...a.entry, retiredAt: iso(T0 - DAY) }]), /retired before it came into use/);
  assert.match(problems([{ ...a.entry, purposes: ["encryption"] }]), /purposes must be some of evidence-pack, release-artifact/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "pem", type: "spki" }).toString();
  assert.match(problems([{ ...a.entry, publicKey: rsa }]), /publicKey is not an Ed25519 public key in PEM/);
  assert.deepEqual(parseKeyring(readFileSync(PUBLISHED_KEYRING_PATH, "utf8")).problems, [], "the published keyring is valid and holds public keys only");

  const dir = mkdtempSync(join(tmpdir(), "gauss-signing-"));
  try {
    const keyFile = join(dir, "evidence.pem");
    writeFileSync(keyFile, pem);
    chmodSync(keyFile, 0o644);
    assert.throws(() => loadSigningKey(keyFile, repoRoot), /evidence\.pem can be read by other users \(mode 644\): chmod 600 it/);
    chmodSync(keyFile, 0o600);
    assert.equal(keyIdOf(loadSigningKey(keyFile, repoRoot)), a.entry.keyId);
    assert.throws(() => loadSigningKey(keyFile, dir), /is inside the repository/);
    const notKey = join(dir, "not-a-key.pem");
    writeFileSync(notKey, "not a key", { mode: 0o600 });
    assert.throws(() => loadSigningKey(notKey, repoRoot), /not-a-key\.pem is not an unencrypted PEM private key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trust CLI: make a key, publish it, sign a pack and PDF, and check both offline with one command; a rewritten pack, a missing signature or a revoked key exits 1, a retired key passes with a note (GAU-67)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gauss-trust-cli-"));
  const run = (script: string, ...a: string[]) => spawnSync(process.execPath, ["--import", "tsx", `scripts/trust/${script}.ts`, ...a], { cwd: repoRoot, encoding: "utf8" });
  const inRepoKey = join(repoRoot, "gauss-test-key.pem");
  try {
    const keyFile = join(dir, "keys", "evidence.pem");
    const made = run("keys", "new", "--out", keyFile, "--purpose", "evidence-pack", "--note", "test key");
    assert.equal(made.status, 0, made.stderr);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.ok(!/PRIVATE KEY/.test(made.stdout + made.stderr), "the private key is never printed");
    assert.equal(run("keys", "new", "--out", keyFile, "--purpose", "evidence-pack").status, 1, "a key file is never overwritten");
    assert.equal(run("keys", "new", "--out", inRepoKey, "--purpose", "evidence-pack").status, 1, "nor written inside the repository");
    const entry = JSON.parse(made.stdout) as KeyringEntry;
    const keyringFile = join(dir, "signing-keys.json");
    writeFileSync(keyringFile, JSON.stringify(ring(entry)));

    const { pack } = await packFromStoredInputs();
    const [packFile, pdfFile, unsignedFile, forgedFile] = ["pack.json", "pack.pdf", "unsigned.json", "forged.json"].map((f) => join(dir, f));
    writeFileSync(packFile, JSON.stringify(pack));
    writeFileSync(unsignedFile, JSON.stringify(pack));
    const signed = run("sign", packFile, "--sign-key", keyFile, "--pdf", pdfFile, "--keyring", keyringFile);
    assert.equal(signed.status, 0, signed.stderr);

    const ok = run("verify-pack", packFile, "--pdf", pdfFile, "--keyring", keyringFile);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`OK\\. 3 records, pack hash ${pack.packHash}; signed by key ${entry.keyId} on \\S+ \\(keyring ${keyringFile}\\); ${pdfFile} matches`));

    writeFileSync(forgedFile, JSON.stringify(rewrite(JSON.parse(readFileSync(packFile, "utf8")) as EvidencePack)));
    const forged = run("verify-pack", forgedFile, "--keyring", keyringFile);
    assert.equal(forged.status, 1);
    assert.match(forged.stderr, /FAILED\n {2}- the signature does not verify/);

    assert.equal(run("verify-pack", unsignedFile, "--keyring", keyringFile).status, 1, "unsigned fails by default");
    const integrityOnly = run("verify-pack", "--allow-unsigned", unsignedFile, "--keyring", keyringFile);
    assert.equal(integrityOnly.status, 0, integrityOnly.stderr);
    assert.match(integrityOnly.stdout, /NOTE: NOT SIGNED: integrity only/);

    writeFileSync(keyringFile, JSON.stringify(ring({ ...entry, retiredAt: iso(Date.now()) })));
    const retired = run("verify-pack", packFile, "--keyring", keyringFile);
    assert.equal(retired.status, 0, retired.stderr);
    assert.match(retired.stdout, /NOTE: key ed25519:\w+ was retired on .* \(rotated out\)/);
    writeFileSync(keyringFile, JSON.stringify(ring({ ...entry, revokedAt: iso(Date.now()) })));
    const revoked = run("verify-pack", packFile, "--keyring", keyringFile);
    assert.equal(revoked.status, 1);
    assert.match(revoked.stderr, /was revoked on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(inRepoKey, { force: true });
  }
});
