import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { auth, CLIENT_IP_HEADER } from "./better-auth.js";

const BASE_URL = "http://localhost:3001";

async function testAuth() {
  // Production's rate limit and IP settings, on a throwaway database.
  const instance = betterAuth({
    database: new Database(":memory:"),
    baseURL: BASE_URL,
    secret: "test-only-secret-0123456789abcdef0123456789",
    trustedOrigins: [BASE_URL],
    emailAndPassword: { enabled: true },
    rateLimit: auth.options.rateLimit,
    advanced: auth.options.advanced,
  });
  await (await getMigrations(instance.options)).runMigrations();
  return instance;
}

function signIn(instance: Awaited<ReturnType<typeof testAuth>>, ip: string, forwardedFor = "198.51.100.1") {
  return instance.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE_URL,
        [CLIENT_IP_HEADER]: ip,
        "x-forwarded-for": forwardedFor,
      },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password-guess" }),
    }),
  );
}

test("auth rate limit is on whatever NODE_ENV says", () => {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.equal(auth.options.rateLimit?.enabled, true);
});

test("password guessing from one address is cut off after 5 tries a minute", async () => {
  const instance = await testAuth();
  const statuses: number[] = [];
  // A client rotating X-Forwarded-For stays in one bucket: only the server-set header counts.
  for (let i = 0; i < 6; i++) statuses.push((await signIn(instance, "203.0.113.9", `198.51.100.${i}`)).status);
  assert.ok(statuses.slice(0, 5).every((s) => s !== 429), `first five: ${statuses.join(",")}`);
  assert.equal(statuses[5], 429, `sixth: ${statuses.join(",")}`);

  // Another address is unaffected.
  assert.notEqual((await signIn(instance, "203.0.113.10")).status, 429);
});
