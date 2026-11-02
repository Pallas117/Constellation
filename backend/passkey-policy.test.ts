import assert from "node:assert/strict";
import test from "node:test";
import {
  STEP_UP_MAX_AGE_MS,
  passkeyConfigFrom,
  passkeyCredentialFrom,
  passkeyOriginAllowed,
  stepUpFresh,
  toMillis,
} from "./passkey-policy.js";

const DEFAULT_CORS = ["http://localhost:8080", "http://localhost:5173", "http://127.0.0.1:5173", "http://127.0.0.1:8080"];

test("passkeys default to RP ID localhost and only its secure origins", () => {
  const config = passkeyConfigFrom({}, DEFAULT_CORS);
  assert.equal(config.rpID, "localhost");
  assert.deepEqual(config.origins, ["http://localhost:8080", "http://localhost:5173"]);
  // 127.0.0.1 is a secure context, but an IP address can't use RP ID "localhost".
  assert.deepEqual(config.rejected, ["http://127.0.0.1:5173", "http://127.0.0.1:8080"]);
});

test("passkey origins must be https (or http on localhost) and on the RP ID's host", () => {
  const rp = "gauss.example.ts.net";
  assert.equal(passkeyOriginAllowed("https://gauss.example.ts.net", rp), true);
  assert.equal(passkeyOriginAllowed("https://ops.gauss.example.ts.net", rp), true, "a subdomain may use its parent's RP ID");
  assert.equal(passkeyOriginAllowed("http://gauss.example.ts.net", rp), false, "plain HTTP on the tailnet is not a secure context");
  assert.equal(passkeyOriginAllowed("https://gauss.example.ts.net.evil.com", rp), false);
  assert.equal(passkeyOriginAllowed("https://evilgauss.example.ts.net", rp), false);
  assert.equal(passkeyOriginAllowed("https://gauss.example.ts.net/", rp), false, "an origin has no trailing slash");
  assert.equal(passkeyOriginAllowed("https://gauss.example.ts.net/login", rp), false);
  assert.equal(passkeyOriginAllowed("https://user:pw@gauss.example.ts.net", rp), false);
  assert.equal(passkeyOriginAllowed("not a url", rp), false);
  assert.equal(passkeyOriginAllowed("http://localhost:8080", "localhost"), true);
  assert.equal(passkeyOriginAllowed("http://localhost.evil.com", "localhost"), false);
});

test("PASSKEY_RP_ID and PASSKEY_ORIGINS move passkeys to an HTTPS host, dropping origins that can't work", () => {
  const config = passkeyConfigFrom(
    { PASSKEY_RP_ID: " Gauss.Example.ts.net ", PASSKEY_ORIGINS: "https://gauss.example.ts.net, http://gauss.example.ts.net,http://localhost:8080" },
    DEFAULT_CORS,
  );
  assert.equal(config.rpID, "gauss.example.ts.net");
  assert.deepEqual(config.origins, ["https://gauss.example.ts.net"]);
  assert.deepEqual(config.rejected, ["http://gauss.example.ts.net", "http://localhost:8080"]);
  assert.deepEqual(passkeyConfigFrom({ PASSKEY_RP_ID: "127.0.0.1" }, DEFAULT_CORS).origins, [], "an IP RP ID turns passkeys off");
});

test("the signed-in credential is read from the verified response id, bounded", () => {
  assert.equal(passkeyCredentialFrom({ response: { id: "cred-abc" } }), "cred-abc");
  assert.equal(passkeyCredentialFrom({ response: { id: "" } }), null);
  assert.equal(passkeyCredentialFrom({ response: { id: 42 } }), null);
  assert.equal(passkeyCredentialFrom({ response: { id: "x".repeat(1025) } }), null);
  assert.equal(passkeyCredentialFrom(null), null);
  assert.equal(passkeyCredentialFrom("response"), null);
});

test("step-up is fresh only for a passkey touch within 5 minutes", () => {
  const now = Date.parse("2026-11-02T08:00:00Z");
  assert.equal(stepUpFresh(now - 1000, now), true);
  assert.equal(stepUpFresh(now - STEP_UP_MAX_AGE_MS, now), true);
  assert.equal(stepUpFresh(now - STEP_UP_MAX_AGE_MS - 1, now), false);
  assert.equal(stepUpFresh(now + 10 * 60_000, now), false, "a touch from the future is not trusted");
  assert.equal(stepUpFresh(null, now), false);
  assert.equal(stepUpFresh(undefined, now), false);
  assert.equal(toMillis(new Date(now)), now);
  assert.equal(toMillis(new Date(now).toISOString()), now);
  assert.equal(toMillis(now), now);
  assert.equal(toMillis("not a date"), null);
  assert.equal(toMillis(new Date(Number.NaN)), null);
  assert.equal(toMillis(null), null);
});
