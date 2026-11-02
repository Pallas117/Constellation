/**
 * Signing (PR-04a, GAU-67): Ed25519 signatures over evidence packs and release files, checked
 * against a published keyring of public keys. Node's built-in crypto only.
 *
 * What is signed is a short canonical statement, not the file: its type (so a release-file
 * signature can never pass as a pack signature), the key id, the signing time and what it vouches
 * for (a pack's id, pack hash and chain head; a file's name, size and SHA-256). The pack hash is
 * recomputed from the pack, so changing any record breaks the signature even when every hash in
 * the pack was recomputed. The key id is the SHA-256 fingerprint of the public key: a verifier
 * finds the key by id, and rotation is a new keyring entry while old signatures keep naming theirs.
 *
 * Key states: current; retired (rotated out: signatures made before `retiredAt` still stand and
 * the verifier says the key is retired, later ones are refused); revoked (may be compromised:
 * nothing it signed is accepted). The keyring is the trust anchor, so a customer takes it from
 * Gauss, never from the pack. Key storage and rotation: docs/EVIDENCE_SIGNING.md.
 *
 * Export control (REG-04): signing, authentication and their key management only. Nothing here
 * encrypts data. The private key is read from a file outside the repository that only its owner
 * can read; it is never logged, put in a URL or an environment variable, or written anywhere else.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { packHashOf, verifyEvidencePack, type EvidencePack } from "./evidence.js";
import { canonicalJson } from "./record.js";

export const KEYRING_SCHEMA = "gauss.signing-keys/0.1";
export const PACK_SIGNATURE_TYPE = "gauss.evidence-pack-signature/0.1";
export const FILE_SIGNATURE_TYPE = "gauss.release-artifact-signature/0.1";
export const KEY_PURPOSES = ["evidence-pack", "release-artifact"] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];
/** The published keyring, committed with the code; customers use the copy Gauss gives them. */
export const PUBLISHED_KEYRING_PATH = fileURLToPath(new URL("./signing-keys.json", import.meta.url));

export interface KeyringEntry {
  /** `ed25519:` and the first 32 hex digits of the SHA-256 of the raw public key. */
  keyId: string;
  algorithm: "Ed25519";
  purposes: KeyPurpose[];
  /** SPKI PEM, so OpenSSL and other tools read it too. */
  publicKey: string;
  /** When signing with it started (ISO time). */
  validFrom: string;
  /** Rotated out at this time: signatures made before it stand, later ones are refused. */
  retiredAt: string | null;
  /** May be compromised: nothing it signed is accepted. */
  revokedAt: string | null;
  note?: string;
}

export interface Keyring {
  schema: typeof KEYRING_SCHEMA;
  keys: KeyringEntry[];
}

interface SignatureFields {
  algorithm: "Ed25519";
  keyId: string;
  /** When it was signed (ISO time); part of the signed statement. */
  signedAt: string;
  /** Base64 Ed25519 signature (64 bytes) over the canonical statement. */
  value: string;
}
export interface PackSignature extends SignatureFields {
  type: typeof PACK_SIGNATURE_TYPE;
}
export interface FileSignature extends SignatureFields {
  type: typeof FILE_SIGNATURE_TYPE;
  file: { name: string; bytes: number; sha256: string };
}

export interface SignatureCheck {
  /** Why the signature can't be trusted; empty when it can. */
  problems: string[];
  /** What the reader should know even when it can, e.g. that the key has been retired. */
  notes: string[];
  /** The keyring entry named by the signature, when there is one. */
  key: KeyringEntry | null;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const isTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/** The key id of an Ed25519 key (public, or private: its public half). */
export function keyIdOf(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  if (pub.asymmetricKeyType !== "ed25519") throw new Error(`not an Ed25519 key (${String(pub.asymmetricKeyType)})`);
  return `ed25519:${sha256(Buffer.from(pub.export({ format: "jwk" }).x ?? "", "base64url")).slice(0, 32)}`;
}

/** The keyring entry that publishes a key's public half. */
export function keyringEntry(key: KeyObject, purposes: KeyPurpose[], validFromMs: number, note?: string): KeyringEntry {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return {
    keyId: keyIdOf(pub),
    algorithm: "Ed25519",
    purposes,
    publicKey: pub.export({ format: "pem", type: "spki" }).toString(),
    validFrom: new Date(validFromMs).toISOString(),
    retiredAt: null,
    revokedAt: null,
    ...(note ? { note } : {}),
  };
}

/** A keyring and every problem with it; only entries without problems are kept. */
export function parseKeyring(text: string): { keyring: Keyring; problems: string[] } {
  const empty: Keyring = { schema: KEYRING_SCHEMA, keys: [] };
  if (/PRIVATE KEY/.test(text)) {
    return { keyring: empty, problems: ["the keyring holds private key material: remove it now and rotate that key (docs/EVIDENCE_SIGNING.md)"] };
  }
  let raw: Partial<Keyring>;
  try {
    raw = JSON.parse(text) as Partial<Keyring>;
  } catch {
    return { keyring: empty, problems: ["the keyring is not JSON"] };
  }
  if (raw?.schema !== KEYRING_SCHEMA || !Array.isArray(raw.keys)) return { keyring: empty, problems: [`not a Gauss keyring (schema ${String(raw?.schema)})`] };
  const problems: string[] = [];
  const keys: KeyringEntry[] = [];
  const seen = new Set<string>();
  raw.keys.forEach((e, i) => {
    if (!e || typeof e !== "object") {
      problems.push(`key ${i + 1}: not an object`);
      return;
    }
    const where = `key ${i + 1} (${String(e.keyId)})`;
    const before = problems.length;
    if (e.algorithm !== "Ed25519") problems.push(`${where}: algorithm must be Ed25519`);
    if (!Array.isArray(e.purposes) || e.purposes.length === 0 || !e.purposes.every((p) => KEY_PURPOSES.includes(p))) {
      problems.push(`${where}: purposes must be some of ${KEY_PURPOSES.join(", ")}`);
    }
    if (!isTime(e.validFrom)) problems.push(`${where}: validFrom must be an ISO time`);
    for (const f of ["retiredAt", "revokedAt"] as const) if (e[f] !== null && !isTime(e[f])) problems.push(`${where}: ${f} must be null or an ISO time`);
    if (isTime(e.retiredAt) && isTime(e.validFrom) && Date.parse(e.retiredAt) < Date.parse(e.validFrom)) problems.push(`${where}: retired before it came into use`);
    try {
      if (keyIdOf(createPublicKey(e.publicKey)) !== e.keyId) problems.push(`${where}: keyId is not the fingerprint of its public key`);
    } catch {
      problems.push(`${where}: publicKey is not an Ed25519 public key in PEM`);
    }
    if (seen.has(e.keyId)) problems.push(`${where}: listed twice`);
    seen.add(e.keyId);
    if (problems.length === before) keys.push(e);
  });
  return { keyring: { schema: KEYRING_SCHEMA, keys }, problems };
}

export function loadKeyring(path: string): Keyring {
  const { keyring, problems } = parseKeyring(readFileSync(path, "utf8"));
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  return keyring;
}

export function keyStatus(key: KeyringEntry, atMs = Date.now()): "current" | "retired" | "revoked" | "not yet valid" {
  if (key.revokedAt) return "revoked";
  if (key.retiredAt && atMs >= Date.parse(key.retiredAt)) return "retired";
  if (atMs < Date.parse(key.validFrom)) return "not yet valid";
  return "current";
}

/**
 * The private key in `path`, refusing a file inside the repository (it could be committed) or
 * one other users can read. Errors name the file, never its contents.
 */
export function loadSigningKey(path: string, repoRoot: string): KeyObject {
  const real = realpathSync(path);
  const inRepo = relative(realpathSync(repoRoot), real);
  if (!inRepo.startsWith("..") && !isAbsolute(inRepo)) throw new Error(`${path} is inside the repository: keep signing keys outside it (docs/EVIDENCE_SIGNING.md)`);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`${path} is not a file`);
  if (stat.mode & 0o077) throw new Error(`${path} can be read by other users (mode ${(stat.mode & 0o777).toString(8)}): chmod 600 it`);
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(real));
  } catch {
    throw new Error(`${path} is not an unencrypted PEM private key`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path} is not an Ed25519 key`);
  return key;
}

/** The keyring entry for `privateKey`, if it may sign `purpose` at `atMs`. */
function signerFor(privateKey: KeyObject, keyring: Keyring, purpose: KeyPurpose, atMs: number): KeyringEntry {
  const keyId = keyIdOf(privateKey);
  const entry = keyring.keys.find((k) => k.keyId === keyId);
  if (!entry) throw new Error(`key ${keyId} is not in the keyring: publish its public key before signing with it (npm run trust:keys -- new)`);
  if (!entry.purposes.includes(purpose)) throw new Error(`key ${keyId} is not for ${purpose} signatures`);
  const status = keyStatus(entry, atMs);
  if (status !== "current") throw new Error(`key ${keyId} is ${status}: sign with a current key`);
  return entry;
}

const packStatement = (pack: EvidencePack, s: Omit<PackSignature, "value">) =>
  canonicalJson({
    type: s.type,
    algorithm: s.algorithm,
    keyId: s.keyId,
    signedAt: s.signedAt,
    schema: pack.schema,
    packId: pack.packId,
    packHash: packHashOf(pack),
    chainHead: pack.chain?.head,
  });
const fileStatement = (s: Omit<FileSignature, "value">) =>
  canonicalJson({ type: s.type, algorithm: s.algorithm, keyId: s.keyId, signedAt: s.signedAt, file: s.file });

function checkSignature(statement: string, s: SignatureFields, keyring: Keyring, purpose: KeyPurpose, what: string): SignatureCheck {
  if (s.algorithm !== "Ed25519") return { problems: [`unsupported signature algorithm ${String(s.algorithm)}`], notes: [], key: null };
  const key = keyring.keys.find((k) => k.keyId === s.keyId) ?? null;
  if (!key) return { problems: [`signed by key ${String(s.keyId)}, which is not in the keyring`], notes: [], key: null };
  const problems: string[] = [];
  const notes: string[] = [];
  const value = Buffer.from(typeof s.value === "string" ? s.value : "", "base64");
  const wellFormed = value.length === 64 && value.toString("base64") === s.value;
  if (!wellFormed || !verify(null, Buffer.from(statement), createPublicKey(key.publicKey), value)) {
    problems.push(`the signature does not verify with key ${key.keyId}: the ${what} or its signature was changed`);
  }
  if (!key.purposes.includes(purpose)) problems.push(`key ${key.keyId} is not for ${purpose} signatures`);
  const at = Date.parse(s.signedAt);
  if (!Number.isFinite(at)) problems.push("the signing time is not a valid time");
  else if (at < Date.parse(key.validFrom)) problems.push(`signed ${s.signedAt}, before key ${key.keyId} came into use (${key.validFrom})`);
  if (key.revokedAt) {
    problems.push(`key ${key.keyId} was revoked on ${key.revokedAt}, so nothing it signed can be trusted: ask Gauss for a copy signed with a current key`);
  } else if (key.retiredAt && Number.isFinite(at)) {
    if (at >= Date.parse(key.retiredAt)) problems.push(`signed ${s.signedAt}, after key ${key.keyId} was retired (${key.retiredAt})`);
    else notes.push(`key ${key.keyId} was retired on ${key.retiredAt} (rotated out). This signature was made on ${s.signedAt}, before that, so it stands; newer ones use the current key.`);
  }
  return { problems, notes, key };
}

/** The pack with an Ed25519 signature over its pack hash and chain head; the pack hash does not change. */
export function signPack(pack: EvidencePack, privateKey: KeyObject, keyring: Keyring, signedAtMs = Date.now()): EvidencePack {
  const problems = verifyEvidencePack(pack);
  if (problems.length) throw new Error(`Not signing a pack that does not verify: ${problems.join("; ")}`);
  const key = signerFor(privateKey, keyring, "evidence-pack", signedAtMs);
  const fields = { type: PACK_SIGNATURE_TYPE, algorithm: "Ed25519", keyId: key.keyId, signedAt: new Date(signedAtMs).toISOString() } as const;
  return { ...pack, signature: { ...fields, value: sign(null, Buffer.from(packStatement(pack, fields)), privateKey).toString("base64") } };
}

/** Whether a Gauss key in the keyring signed this pack as it is now. Integrity is `verifyEvidencePack`. */
export function verifyPackSignature(pack: EvidencePack, keyring: Keyring): SignatureCheck {
  const s = pack.signature;
  if (!s) return { problems: ["the pack is not signed, so nothing shows who made it (integrity only)"], notes: [], key: null };
  if (s.type !== PACK_SIGNATURE_TYPE) return { problems: [`not an evidence-pack signature (type ${String(s.type)})`], notes: [], key: null };
  return checkSignature(packStatement(pack, s), s, keyring, "evidence-pack", "pack");
}

/** A detached signature for a release file (an archive, a checksum list, an SBOM). */
export function signFile(bytes: Buffer, name: string, privateKey: KeyObject, keyring: Keyring, signedAtMs = Date.now()): FileSignature {
  const key = signerFor(privateKey, keyring, "release-artifact", signedAtMs);
  const fields = {
    type: FILE_SIGNATURE_TYPE,
    algorithm: "Ed25519",
    keyId: key.keyId,
    signedAt: new Date(signedAtMs).toISOString(),
    file: { name, bytes: bytes.length, sha256: sha256(bytes) },
  } as const;
  return { ...fields, value: sign(null, Buffer.from(fileStatement(fields)), privateKey).toString("base64") };
}

export function verifyFileSignature(bytes: Buffer, name: string, s: FileSignature, keyring: Keyring): SignatureCheck {
  if (s?.type !== FILE_SIGNATURE_TYPE) return { problems: [`not a release-artifact signature (type ${String(s?.type)})`], notes: [], key: null };
  const check = checkSignature(fileStatement(s), s, keyring, "release-artifact", "file");
  if (s.file?.sha256 !== sha256(bytes) || s.file?.bytes !== bytes.length) check.problems.unshift(`${name} is not the file that was signed (its SHA-256 or size differs)`);
  else if (s.file.name !== name) check.notes.push(`signed as ${s.file.name}, checked as ${name}`);
  return check;
}
