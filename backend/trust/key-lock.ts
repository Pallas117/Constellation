/**
 * Geometry lock for Gauss signing keys (GAU-67). The owner locks a private signing key under a
 * pattern drawn on the 16 vertices of a rotating tesseract, the figure of the UI-UX-Gauss
 * GeometricEncryption view. The pattern is stretched with scrypt and the key's PKCS#8 bytes are
 * sealed with AES-256-GCM. The header (schema, key id, figure, KDF settings, lock time) is the
 * additional data, so changing any of it fails the unlock.
 *
 * Only the signing key is encrypted, never user data: this is key management for signing
 * (REG-04, docs/CRYPTO_INVENTORY.md). A pattern of 8 to 24 of 16 vertices holds at most about
 * 31 bits of choice, fewer as people pick them, so the lock slows down someone who copies the
 * file. It adds to file mode 600 and FileVault; it does not replace a hardware key.
 */
import { createCipheriv, createDecipheriv, createPrivateKey, randomBytes, scryptSync, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import { keyIdOf, parseSigningKey, readSigningKeyFile } from "./signing.js";

export const LOCKED_KEY_SCHEMA = "gauss.locked-signing-key/0.1" as const;
export const FIGURE = "tesseract-16" as const;
export const VERTICES = 16;
/** Vertex labels shown on the figure and typed at a terminal: A is vertex 0, P is vertex 15. */
export const VERTEX_LABELS = "ABCDEFGHIJKLMNOP";
export const PATTERN_RULES = { minLength: 8, maxLength: 24, minDistinct: 6 } as const;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}
/** About 0.4 s and 128 MiB per try on an M1 (measured 2026-11-02). */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
// Upper bounds on what a key file may ask for, so a damaged or hostile file can't exhaust memory.
const MAX_N = 2 ** 20;
const MAX_R = 16;
const MAX_P = 4;
const scryptMaxmem = (s: ScryptParams) => 128 * s.N * s.r * s.p + 64 * 1024 * 1024;

export interface LockedKey {
  schema: typeof LOCKED_KEY_SCHEMA;
  keyId: string;
  figure: typeof FIGURE;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm";
  lockedAt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Why `pattern` can't lock a key, or null when it can. */
export function patternProblem(pattern: readonly number[]): string | null {
  if (!pattern.every((v) => Number.isInteger(v) && v >= 0 && v < VERTICES)) return `use vertices ${VERTEX_LABELS[0]} to ${VERTEX_LABELS[VERTICES - 1]} only`;
  const { minLength, maxLength, minDistinct } = PATTERN_RULES;
  if (pattern.length < minLength || pattern.length > maxLength) return `draw ${minLength} to ${maxLength} vertices (this one has ${pattern.length})`;
  if (pattern.some((v, i) => i > 0 && pattern[i - 1] === v)) return "don't pick the same vertex twice in a row";
  if (new Set(pattern).size < minDistinct) return `use at least ${minDistinct} different vertices`;
  return null;
}

/** Vertex ids from labels such as "A F K P" or "afkp", or null if any character is not a label. */
export function parsePatternLabels(text: string): number[] | null {
  const ids = [...text.toUpperCase().replace(/[\s,.-]/g, "")].map((c) => VERTEX_LABELS.indexOf(c));
  return ids.some((i) => i < 0) ? null : ids;
}

const secretOf = (pattern: readonly number[]) => Buffer.from(`${FIGURE}:${pattern.join(".")}`, "utf8");

const aadOf = (k: Omit<LockedKey, "iv" | "tag" | "ciphertext">) =>
  Buffer.from(JSON.stringify({ schema: k.schema, keyId: k.keyId, figure: k.figure, kdf: k.kdf, cipher: k.cipher, lockedAt: k.lockedAt }), "utf8");

function derive(pattern: readonly number[], kdf: LockedKey["kdf"]): Buffer {
  const s = { N: kdf.N, r: kdf.r, p: kdf.p };
  return scryptSync(secretOf(pattern), Buffer.from(kdf.salt, "base64"), 32, { ...s, maxmem: scryptMaxmem(s) });
}

/** Lock `privateKey` under `pattern`. Throws when the pattern breaks PATTERN_RULES. */
export function lockKey(privateKey: KeyObject, pattern: readonly number[], options: { scrypt?: ScryptParams; nowMs?: number } = {}): LockedKey {
  const problem = patternProblem(pattern);
  if (problem) throw new Error(`pattern refused: ${problem}`);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("only Ed25519 signing keys are locked");
  const s = options.scrypt ?? DEFAULT_SCRYPT;
  const header: Omit<LockedKey, "iv" | "tag" | "ciphertext"> = {
    schema: LOCKED_KEY_SCHEMA,
    keyId: keyIdOf(privateKey),
    figure: FIGURE,
    kdf: { name: "scrypt", N: s.N, r: s.r, p: s.p, salt: randomBytes(16).toString("base64") },
    cipher: "aes-256-gcm",
    lockedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
  };
  const key = derive(pattern, header.kdf);
  const iv = randomBytes(12);
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(aadOf(header));
    const ciphertext = Buffer.concat([cipher.update(der), cipher.final()]);
    return { ...header, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  } finally {
    key.fill(0);
    der.fill(0);
  }
}

/** The key locked in `locked`. Throws "pattern does not match" for a wrong pattern or a changed file. */
export function unlockKey(locked: LockedKey, pattern: readonly number[]): KeyObject {
  const mismatch = () => new Error("pattern does not match");
  if (patternProblem(pattern)) throw mismatch();
  const key = derive(pattern, locked.kdf);
  let der: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(locked.iv, "base64")).setAAD(aadOf(locked));
    decipher.setAuthTag(Buffer.from(locked.tag, "base64"));
    der = Buffer.concat([decipher.update(Buffer.from(locked.ciphertext, "base64")), decipher.final()]);
  } catch {
    throw mismatch();
  } finally {
    key.fill(0);
  }
  try {
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519" || keyIdOf(privateKey) !== locked.keyId) throw new Error("the locked key does not match its key id");
    return privateKey;
  } finally {
    der.fill(0);
  }
}

const isB64 = (v: unknown, bytes?: number) => typeof v === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && (bytes === undefined || Buffer.from(v, "base64").length === bytes);
const isPow2 = (n: number) => Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;

/** The locked key in `bytes`, null when they are not a locked key file, or an error for a damaged one. */
export function parseLockedKey(bytes: Buffer): LockedKey | null {
  if (bytes[0] !== 0x7b) return null;
  let k: LockedKey;
  try {
    k = JSON.parse(bytes.toString("utf8")) as LockedKey;
  } catch {
    throw new Error("the locked key file is not valid JSON");
  }
  const kdf = k?.kdf;
  const ok =
    k?.schema === LOCKED_KEY_SCHEMA &&
    /^ed25519:[0-9a-f]{32}$/.test(String(k.keyId)) &&
    k.figure === FIGURE &&
    kdf?.name === "scrypt" &&
    isPow2(kdf.N) &&
    kdf.N <= MAX_N &&
    Number.isInteger(kdf.r) &&
    kdf.r >= 1 &&
    kdf.r <= MAX_R &&
    Number.isInteger(kdf.p) &&
    kdf.p >= 1 &&
    kdf.p <= MAX_P &&
    isB64(kdf.salt, 16) &&
    k.cipher === "aes-256-gcm" &&
    !Number.isNaN(Date.parse(k.lockedAt)) &&
    isB64(k.iv, 12) &&
    isB64(k.tag, 16) &&
    isB64(k.ciphertext);
  if (!ok) throw new Error(`not a ${LOCKED_KEY_SCHEMA} file, or a damaged one`);
  return k;
}

/** Write `locked` to `path` (mode 600, never over an existing file). */
export function writeLockedKey(path: string, locked: LockedKey): void {
  writeFileSync(path, JSON.stringify(locked, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

/**
 * Asks for a pattern until `attempt` accepts one, the owner gives up or the prompt runs out of
 * tries; resolves true once an attempt was accepted.
 */
export type PatternPrompt = (attempt: (pattern: number[]) => boolean) => Promise<boolean>;

/**
 * The private key in `path`, asking `prompt` for the pattern when the file is locked. The file
 * checks are readSigningKeyFile's; an unlocked PEM file needs no prompt.
 */
export async function openSigningKey(path: string, repoRoot: string, prompt: PatternPrompt): Promise<KeyObject> {
  const bytes = readSigningKeyFile(path, repoRoot);
  let locked: LockedKey | null;
  try {
    locked = parseLockedKey(bytes);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`, { cause: e });
  }
  if (!locked) return parseSigningKey(bytes, path);
  const lockedKey = locked;
  let key: KeyObject | undefined;
  const unlocked = await prompt((pattern) => {
    try {
      key = unlockKey(lockedKey, pattern);
      return true;
    } catch {
      return false;
    }
  });
  if (!unlocked || !key) throw new Error(`${path} was not unlocked`);
  return key;
}
