import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import Database from "better-sqlite3";
import { auth } from "./better-auth.js";
import { toMillis } from "./passkey-policy.js";

// The production passkey setup (plugin options, session fields, hooks) on a
// throwaway database, driven through better-auth's own HTTP handler by a
// software authenticator. Real browsers do the same with Touch ID or Face ID.

const BASE = "http://localhost:3001";
const ORIGIN = "http://localhost:8080"; // in the default ALLOWED_ORIGINS, so a passkey origin
const RP_ID = "localhost";

const FLAG_UP = 0x01; // user present (a touch)
const FLAG_UV = 0x04; // user verified (biometric or device PIN)
const FLAG_AT = 0x40; // attested credential data follows

const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

/** The little CBOR a "none" attestation needs: small ints, text, bytes and maps. */
function cbor(value: Cbor): Uint8Array {
  const head = (major: number, n: number) =>
    n < 24 ? new Uint8Array([(major << 5) | n]) : n < 256 ? new Uint8Array([(major << 5) | 24, n]) : new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const text = new TextEncoder().encode(value);
    return concat(head(3, text.length), text);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
}

/** A passkey on a "device": an ES256 key pair and a signature counter. */
class SoftAuthenticator {
  readonly credentialId = new Uint8Array(randomBytes(16));
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private counter = 0;

  constructor() {
    ({ privateKey: this.privateKey, publicKey: this.publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }));
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  private authData(flags: number, attested?: Uint8Array): Uint8Array {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    return concat(sha256(RP_ID), new Uint8Array([flags]), new Uint8Array(counter), ...(attested ? [attested] : []));
  }

  register(options: { challenge: string }, { origin = ORIGIN, verified = true } = {}) {
    const jwk = this.publicKey.export({ format: "jwk" });
    const cose = cbor(
      new Map<number, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, new Uint8Array(Buffer.from(jwk.x ?? "", "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y ?? "", "base64url"))],
      ]),
    );
    const idLength = new Uint8Array([this.credentialId.length >> 8, this.credentialId.length & 0xff]);
    const attested = concat(new Uint8Array(16), idLength, this.credentialId, cose); // zero AAGUID
    const authData = this.authData(FLAG_UP | FLAG_AT | (verified ? FLAG_UV : 0), attested);
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false });
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64url(new TextEncoder().encode(clientDataJSON)), attestationObject: b64url(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  assert(options: { challenge: string }, { origin = ORIGIN, verified = true } = {}) {
    const authenticatorData = this.authData(FLAG_UP | (verified ? FLAG_UV : 0));
    const clientData = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const signature = new Uint8Array(sign("sha256", concat(authenticatorData, sha256(clientData)), this.privateKey));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authenticatorData), signature: b64url(signature) },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

/** The fields of better-auth's JSON answers these tests read. */
interface AuthJson {
  user: { id: string };
  session: { passkeyAt?: unknown; passkeyCredentialId?: unknown } | null;
  rp: { id: string };
  rpId: string;
  challenge: string;
  userVerification: string;
  authenticatorSelection: { userVerification: string; residentKey: string };
  allowCredentials?: Array<{ id: string }>;
}

/** One browser: a cookie jar in front of better-auth's handler. */
class Browser {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly handler: (request: Request) => Promise<Response>) {}

  get sessionToken(): string | undefined {
    return [...this.cookies].find(([name]) => name.endsWith("session_token"))?.[1];
  }

  async call(path: string, body?: unknown, origin = ORIGIN): Promise<{ status: number; json: AuthJson }> {
    const response = await this.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (!value || attributes.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }
}

async function setup() {
  const db = new Database(":memory:");
  const testAuth = betterAuth({
    database: db,
    baseURL: BASE,
    secret: "test-only-secret-0123456789abcdef0123456789",
    trustedOrigins: [ORIGIN, BASE],
    emailAndPassword: { enabled: true },
    user: auth.options.user,
    session: auth.options.session,
    plugins: auth.options.plugins,
    hooks: auth.options.hooks,
    databaseHooks: auth.options.databaseHooks,
  });
  await (await getMigrations(testAuth.options)).runMigrations();
  const handler = (request: Request) => testAuth.handler(request);
  const browser = new Browser(handler);
  const signUp = await browser.call("/sign-up/email", { email: "op@example.com", password: "a-long-test-password", name: "Op" });
  assert.equal(signUp.status, 200, JSON.stringify(signUp.json));
  return { db, handler, browser, userId: signUp.json.user.id as string };
}

async function register(browser: Browser, device: SoftAuthenticator, options?: Parameters<SoftAuthenticator["register"]>[1]) {
  const creation = await browser.call("/passkey/generate-register-options");
  assert.equal(creation.status, 200, JSON.stringify(creation.json));
  return { creation: creation.json, result: await browser.call("/passkey/verify-registration", { response: device.register(creation.json, options), name: "Test Mac" }) };
}

async function passkeySignIn(browser: Browser, device: SoftAuthenticator, options?: Parameters<SoftAuthenticator["assert"]>[1]) {
  const request = await browser.call("/passkey/generate-authenticate-options");
  assert.equal(request.status, 200, JSON.stringify(request.json));
  return { request: request.json, result: await browser.call("/passkey/verify-authentication", { response: device.assert(request.json, options) }) };
}

test("passkey registration asks for a discoverable, user-verifying credential and stores only public data", async () => {
  const { db, browser, userId } = await setup();
  const device = new SoftAuthenticator();
  const { creation, result } = await register(browser, device);
  assert.equal(creation.rp.id, "localhost");
  assert.equal(creation.authenticatorSelection.userVerification, "required");
  assert.equal(creation.authenticatorSelection.residentKey, "required");
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const row = db.prepare("SELECT * FROM passkey WHERE userId = ?").get(userId) as Record<string, unknown>;
  assert.equal(row.credentialID, device.id);
  assert.equal(row.name, "Test Mac");
  assert.deepEqual(
    Object.keys(row).sort(),
    ["aaguid", "backedUp", "counter", "createdAt", "credentialID", "deviceType", "id", "name", "publicKey", "transports", "userId"],
    "a credential ID, public key and counter: nothing biometric",
  );
});

test("a passkey that did not verify the person is refused at registration", async () => {
  const { db, browser, userId } = await setup();
  const { result } = await register(browser, new SoftAuthenticator(), { verified: false });
  assert.equal(result.status, 400);
  assert.equal((db.prepare("SELECT count(*) AS n FROM passkey WHERE userId = ?").get(userId) as { n: number }).n, 0);
});

test("one-touch passkey sign-in opens a session stamped with the touch time and credential", async () => {
  const { handler, browser, userId } = await setup();
  const device = new SoftAuthenticator();
  assert.equal((await register(browser, device)).result.status, 200);

  const password = await browser.call("/get-session");
  assert.equal(password.json.session?.passkeyAt ?? null, null, "a password session never counts as a passkey touch");

  const fresh = new Browser(handler); // a new browser: usernameless, nothing typed
  const { request, result } = await passkeySignIn(fresh, device);
  assert.equal(request.userVerification, "required", "the browser is asked for Touch ID / Face ID, not just a tap");
  assert.equal(request.rpId, "localhost");
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.user.id, userId);

  const session = await fresh.call("/get-session");
  const touched = toMillis(session.json.session?.passkeyAt);
  assert.ok(touched !== null && Math.abs(Date.now() - touched) < 10_000, `passkeyAt ${String(session.json.session?.passkeyAt)}`);
  assert.equal(session.json.session?.passkeyCredentialId, device.id);
});

test("passkey sign-in without user verification, from a foreign origin or with an unknown key opens no session", async () => {
  const { handler, browser } = await setup();
  const device = new SoftAuthenticator();
  assert.equal((await register(browser, device)).result.status, 200);

  const tapOnly = new Browser(handler);
  assert.equal((await passkeySignIn(tapOnly, device, { verified: false })).result.status, 401);
  assert.equal(tapOnly.sessionToken, undefined);

  const phishing = new Browser(handler);
  assert.equal((await passkeySignIn(phishing, device, { origin: "https://gauss-login.example" })).result.status, 400);
  assert.equal(phishing.sessionToken, undefined);

  const stranger = new Browser(handler);
  assert.equal((await passkeySignIn(stranger, new SoftAuthenticator())).result.status, 401);
  assert.equal(stranger.sessionToken, undefined);
});

test("a passkey step-up replaces the browser's previous session and revokes it", async () => {
  const { db, browser, userId } = await setup();
  const device = new SoftAuthenticator();
  assert.equal((await register(browser, device)).result.status, 200);
  const before = browser.sessionToken;
  assert.ok(before);

  const { request, result } = await passkeySignIn(browser, device);
  assert.equal(result.status, 200);
  assert.deepEqual(
    request.allowCredentials?.map((c) => c.id),
    [device.id],
    "signed in, the browser is offered only this account's passkeys",
  );
  assert.notEqual(browser.sessionToken, before);
  const sessions = db.prepare("SELECT token, passkeyAt FROM session WHERE userId = ?").all(userId) as Array<{ token: string; passkeyAt: unknown }>;
  assert.equal(sessions.length, 1, "the password session is gone");
  assert.ok(toMillis(sessions[0].passkeyAt));
});

test("sessions slide: one unused for 12 hours expires", async () => {
  const { db, browser, userId } = await setup();
  assert.ok(browser.sessionToken);
  const row = db.prepare("SELECT createdAt, expiresAt FROM session WHERE userId = ?").get(userId) as { createdAt: unknown; expiresAt: unknown };
  const lifetime = (toMillis(row.expiresAt) ?? 0) - (toMillis(row.createdAt) ?? 0);
  assert.ok(Math.abs(lifetime - 12 * 3600_000) < 60_000, `session lifetime ${lifetime} ms`);
});
