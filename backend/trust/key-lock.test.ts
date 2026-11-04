import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  lockKey,
  openSigningKey,
  parseLockedKey,
  parsePatternLabels,
  patternProblem,
  unlockKey,
  writeLockedKey,
  type LockedKey,
  type PatternPrompt,
  type ScryptParams,
} from "./key-lock.js";
import { startPatternPage } from "./pattern-page.js";
import { keyIdOf, keyringEntry, loadSigningKey, type KeyringEntry } from "./signing.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
// Cheap settings for the library tests; the CLI test runs the real ones.
const FAST: ScryptParams = { N: 2 ** 10, r: 8, p: 1 };
const PATTERN = [0, 5, 10, 15, 2, 7, 12, 1]; // A F K P C H M B
const OTHER = [0, 5, 10, 15, 2, 7, 12, 3];

/** A prompt that offers `tries` in turn and reports whether one was accepted. */
const offering =
  (...tries: number[][]): PatternPrompt =>
  async (attempt) =>
    tries.some((p) => attempt(p));

test("key lock: a key locked under a tesseract pattern unlocks only with that pattern; a changed header, a weak pattern and a damaged file are refused, and the key is never stored in the clear (GAU-67)", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const locked = lockKey(privateKey, PATTERN, { scrypt: FAST });
  const text = JSON.stringify(locked);
  assert.equal(locked.keyId, keyIdOf(privateKey));
  assert.ok(!/PRIVATE KEY/.test(text));
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  assert.ok(!Buffer.from(locked.ciphertext, "base64").equals(der), "the key bytes are sealed, not copied");
  assert.ok(!text.includes(der.subarray(16).toString("base64").slice(0, 20)), "no run of the raw key appears in the file");

  assert.equal(keyIdOf(unlockKey(locked, PATTERN)), keyIdOf(privateKey));
  assert.throws(() => unlockKey(locked, OTHER), /pattern does not match/);
  assert.throws(() => unlockKey(locked, PATTERN.slice(0, 7)), /pattern does not match/);
  const other = keyIdOf(generateKeyPairSync("ed25519").privateKey);
  const changed: LockedKey[] = [
    { ...locked, keyId: other },
    { ...locked, lockedAt: "2026-01-01T00:00:00.000Z" },
    { ...locked, kdf: { ...locked.kdf, N: 2 ** 11 } },
    { ...locked, ciphertext: Buffer.from(Buffer.from(locked.ciphertext, "base64").map((b, i) => (i === 3 ? b ^ 1 : b))).toString("base64") },
  ];
  for (const k of changed) assert.throws(() => unlockKey(k, PATTERN), /pattern does not match/);

  assert.match(String(patternProblem([0, 1, 2, 3, 4, 5, 6])), /8 to 24/);
  assert.match(String(patternProblem([0, 1, 1, 2, 3, 4, 5, 6])), /twice in a row/);
  assert.match(String(patternProblem([0, 1, 0, 1, 2, 0, 1, 2])), /at least 6 different/);
  assert.match(String(patternProblem([0, 1, 2, 3, 4, 5, 6, 16])), /A to P/);
  assert.equal(patternProblem(PATTERN), null);
  assert.throws(() => lockKey(privateKey, [0, 1, 2], { scrypt: FAST }), /pattern refused/);
  assert.deepEqual(parsePatternLabels("a f k p c h m b"), PATTERN);
  assert.equal(parsePatternLabels("AFKZ"), null);

  assert.equal(parseLockedKey(Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" }))), null, "a PEM file is not a locked key");
  assert.deepEqual(parseLockedKey(Buffer.from(text)), locked);
  for (const bad of [{ ...locked, kdf: { ...locked.kdf, N: 3000 } }, { ...locked, kdf: { ...locked.kdf, N: 2 ** 24 } }, { ...locked, iv: "AAAA" }, { ...locked, schema: "x" }])
    assert.throws(() => parseLockedKey(Buffer.from(JSON.stringify(bad))), /damaged/);

  const dir = mkdtempSync(join(tmpdir(), "gauss-key-lock-"));
  try {
    const file = join(dir, "evidence.locked");
    writeLockedKey(file, locked);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => writeLockedKey(file, locked), "a key file is never overwritten");
    assert.throws(() => loadSigningKey(file, repoRoot), /locked under a geometry pattern/);
    const opened = await openSigningKey(file, repoRoot, offering(OTHER, PATTERN));
    assert.equal(keyIdOf(opened), locked.keyId);
    await assert.rejects(openSigningKey(file, repoRoot, offering(OTHER)), /was not unlocked/);
    const pem = join(dir, "plain.pem");
    writeFileSync(pem, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    let asked = false;
    await openSigningKey(pem, repoRoot, async () => (asked = true));
    assert.equal(asked, false, "an unlocked key file needs no pattern");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Answer = { status: number; body: string };
function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("key lock page: the one-time pattern page answers only its own address and origin, needs the nonce it served, unlocks once and closes after five misses (GAU-67)", async () => {
  const target = PATTERN.join();
  const page = await startPatternPage((p) => p.join() === target, { mode: "unlock", label: "ed25519:test", open: () => {} });
  const port = Number(new URL(page.url).port);
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  assert.equal(new URL(page.url).pathname, "/", "nothing secret in the address");

  const html = await call(port, "GET", "/", { host });
  assert.equal(html.status, 200);
  const nonce = /"nonce":"([^"]+)"/.exec(html.body)?.[1] ?? "";
  assert.ok(nonce.length > 20);
  assert.equal((await call(port, "GET", "/", { host: `localhost:${port}` })).status, 421, "another host name (DNS rebinding) is refused");
  assert.equal((await call(port, "GET", "/", { host: `evil.example:${port}` })).status, 421);

  const post = (body: object, headers: Record<string, string> = {}) =>
    call(port, "POST", "/attempt", { host, origin, "content-type": "application/json", ...headers }, JSON.stringify(body));
  assert.equal((await post({ nonce, pattern: PATTERN }, { origin: "https://evil.example" })).status, 403, "another origin is refused");
  assert.equal((await post({ nonce: "x".repeat(nonce.length), pattern: PATTERN })).status, 403, "a wrong nonce is refused");
  assert.equal((await post({ pattern: PATTERN })).status, 403, "no nonce is refused");
  assert.equal((await call(port, "POST", "/attempt", { host, origin, "content-type": "text/plain" }, "{}")).status, 415);

  const miss = JSON.parse((await post({ nonce, pattern: OTHER })).body) as { ok: boolean; left: number };
  assert.deepEqual([miss.ok, miss.left], [false, 4]);
  const hit = JSON.parse((await post({ nonce, pattern: PATTERN })).body) as { ok: boolean; done: boolean };
  assert.deepEqual([hit.ok, hit.done], [true, true]);
  assert.equal(await page.done, true);
  await assert.rejects(call(port, "GET", "/", { host }), "the page is gone once the key is unlocked");

  const locked = await startPatternPage(() => false, { mode: "unlock", label: "t", open: () => {} });
  const lport = Number(new URL(locked.url).port);
  const lhost = `127.0.0.1:${lport}`;
  const lnonce = /"nonce":"([^"]+)"/.exec((await call(lport, "GET", "/", { host: lhost })).body)?.[1] ?? "";
  const tries: { ok: boolean; done?: boolean }[] = [];
  for (let i = 0; i < 5; i++)
    tries.push(
      JSON.parse((await call(lport, "POST", "/attempt", { host: lhost, origin: `http://${lhost}`, "content-type": "application/json" }, JSON.stringify({ nonce: lnonce, pattern: OTHER }))).body) as {
        ok: boolean;
        done?: boolean;
      },
    );
  assert.equal(tries.at(-1)?.done, true);
  assert.equal(await locked.done, false, "five misses close the page without unlocking");

  let accepted = 0;
  const setter = await startPatternPage(
    () => {
      accepted++;
      return true;
    },
    { mode: "lock", label: "t", open: () => {} },
  );
  const sport = Number(new URL(setter.url).port);
  const shost = `127.0.0.1:${sport}`;
  const snonce = /"nonce":"([^"]+)"/.exec((await call(sport, "GET", "/", { host: shost })).body)?.[1] ?? "";
  const set = (body: object) => call(sport, "POST", "/attempt", { host: shost, origin: `http://${shost}`, "content-type": "application/json" }, JSON.stringify({ nonce: snonce, ...body }));
  assert.match(JSON.parse((await set({ pattern: [0, 1, 2], confirm: [0, 1, 2] })).body).message as string, /Choose another pattern/);
  assert.match(JSON.parse((await set({ pattern: PATTERN, confirm: OTHER })).body).message as string, /differ/);
  assert.equal(accepted, 0, "a weak or unconfirmed pattern never reaches the lock");
  assert.equal(JSON.parse((await set({ pattern: PATTERN, confirm: PATTERN })).body).ok, true);
  assert.equal(await setter.done, true);
});

test("trust CLI: lock a key under a pattern and remove the unlocked file, sign with it from the terminal, refuse a wrong pattern, and make a key that is locked from the start (GAU-67)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gauss-key-lock-cli-"));
  const run = (input: string, script: string, ...a: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", `scripts/trust/${script}.ts`, ...a], { cwd: repoRoot, encoding: "utf8", input });
  try {
    mkdirSync(join(dir, "keys"), { mode: 0o700 });
    const plain = join(dir, "keys", "release.pem");
    const made = run("", "keys", "new", "--out", plain, "--purpose", "release-artifact");
    assert.equal(made.status, 0, made.stderr);
    const keyring = join(dir, "signing-keys.json");
    writeFileSync(keyring, JSON.stringify({ schema: "gauss.signing-keys/0.1", keys: [JSON.parse(made.stdout) as KeyringEntry] }));

    const lockedFile = `${plain}.locked`;
    const locked = run("AFKPCHMB\nAFKPCHMB\n", "keys", "lock", "--key", plain, "--remove-plain", "--pattern-tty");
    assert.equal(locked.status, 0, locked.stderr);
    assert.equal(statSync(lockedFile).mode & 0o777, 0o600);
    assert.equal(existsSync(plain), false, "--remove-plain deletes the unlocked file");
    assert.ok(!/AFKPCHMB|PRIVATE KEY/.test(locked.stdout + locked.stderr), "neither the pattern nor the key is printed");
    assert.ok(parseLockedKey(readFileSync(lockedFile)));

    const artifact = join(dir, "release.tar");
    writeFileSync(artifact, "release bytes");
    const signed = run("afkp chmb\n", "sign", "--file", artifact, "--sign-key", lockedFile, "--keyring", keyring, "--pattern-tty");
    assert.equal(signed.status, 0, signed.stderr);
    assert.equal(run("", "verify-pack", "--file", artifact, "--keyring", keyring).status, 0);
    const wrong = run("AFKPCHMD\nAFKPCHMN\n", "sign", "--file", artifact, "--sign-key", lockedFile, "--keyring", keyring, "--pattern-tty");
    assert.equal(wrong.status, 1, "a wrong pattern does not sign");
    assert.match(wrong.stderr, /not unlocked/);

    const fresh = join(dir, "keys", "evidence.locked");
    const born = run("AFKPCHMB\nAFKPCHMB\n", "keys", "new", "--lock", "--out", fresh, "--purpose", "evidence-pack", "--pattern-tty");
    assert.equal(born.status, 0, born.stderr);
    assert.equal(parseLockedKey(readFileSync(fresh))?.keyId, (JSON.parse(born.stdout) as KeyringEntry).keyId);
    const entry = keyringEntry(unlockKey(parseLockedKey(readFileSync(fresh)) as LockedKey, PATTERN), ["evidence-pack"], 0);
    assert.equal(entry.keyId, (JSON.parse(born.stdout) as KeyringEntry).keyId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
