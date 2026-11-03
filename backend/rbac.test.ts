import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AuthRole } from "./auth.js";
import { STEP_UP_MAX_AGE_MS } from "./passkey-policy.js";
import { accessFor, API_POLICY, enforceApiPolicy, PATTERN_REQUIRED, PATTERN_SETUP_REQUIRED, policyFor, STEP_UP_REQUIRED, type Access } from "./rbac.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Every route declared in source, as METHOD + path relative to /api. */
function declaredRoutes(): string[] {
  const read = (f: string) => fs.readFileSync(path.join(here, f), "utf8");
  const out: string[] = [];
  for (const m of read("server.ts").matchAll(/app\.(get|post|put|patch|delete)\("\/api(\/[^"]+)"/g)) {
    out.push(`${m[1].toUpperCase()} ${m[2]}`);
  }
  for (const m of read("device-registry.ts").matchAll(/router\.(get|post|put|patch|delete)\("([^"]+)"/g)) {
    out.push(`${m[1].toUpperCase()} ${("/device" + m[2]).replace(/\/$/, "")}`);
  }
  for (const m of read("mesh/router.ts").matchAll(/ui\.(get|post|put|patch|delete)\("([^"]+)"/g)) {
    out.push(`${m[1].toUpperCase()} /mesh${m[2]}`);
  }
  for (const m of read("commerce/routers.ts").matchAll(/router\.(get|post|put|patch|delete)\("([^"]+)"/g)) {
    if (!m[2].startsWith("/data/")) out.push(`${m[1].toUpperCase()} /orgs${m[2]}`); // /data/* is the key-authenticated /api/v1
  }
  for (const m of read("admin/users.ts").matchAll(/router\.(get|post|put|patch|delete)\("([^"]+)"/g)) {
    out.push(`${m[1].toUpperCase()} ${("/admin/users" + m[2]).replace(/\/$/, "")}`);
  }
  for (const m of read("pattern/router.ts").matchAll(/router\.(get|post|put|patch|delete)\("([^"]+)"/g)) {
    out.push(`${m[1].toUpperCase()} ${("/operator-pattern" + m[2]).replace(/\/$/, "")}`);
  }
  // Handled before the policy middleware by design (see rbac.ts header).
  return out.filter((r) => r !== "GET /sso-options");
}

test("every declared API route has an access policy (deny by default otherwise)", () => {
  const routes = declaredRoutes();
  assert.ok(routes.length > 30, `found only ${routes.length} routes; the scanner is broken`);
  const missing = routes.filter((r) => {
    const [method, p] = r.split(" ");
    return accessFor(method, p.replace(/:(\w+)/g, "x")) === undefined;
  });
  assert.deepEqual(missing, [], `routes without a policy in backend/rbac.ts: ${missing.join(", ")}`);
});

test("role matrix", () => {
  const cases: Array<[string, string, Access]> = [
    ["GET", "/feed/space-weather/latest", "public"],
    ["GET", "/system/connectivity", "public"],
    ["GET", "/feed/aurora/map", "user"],
    ["GET", "/device", "user"],
    ["GET", "/device/abc123", "user"],
    ["GET", "/device/swap/plan", "operator"], // exact path beats /device/:id
    ["POST", "/device/abc123/quality", "operator"],
    ["GET", "/mesh/devices", "staff"],
    ["DELETE", "/mesh/devices/judith", "staff"],
    ["POST", "/rag/query", "operator"],
    ["GET", "/swx/structures", "operator"], // L1 structure candidates (GAU-154)
    ["GET", "/security/cybertiger/events", "admin"],
    ["POST", "/ai/nowcast/train", "admin"],
    ["GET", "/admin/users", "admin"],
    ["POST", "/admin/users/u-123/role", "admin"],
  ];
  for (const [m, p, want] of cases) assert.equal(accessFor(m, p), want, `${m} ${p}`);
  assert.equal(accessFor("POST", "/feed/space-weather/latest"), undefined, "public is GET-only");
  assert.equal(accessFor("GET", "/admin/secrets"), undefined);
});

/** The JSON body of the last refusal run() saw. */
let lastBody: unknown;

/** Sessions have drawn their operator pattern unless a test says otherwise. */
function run(method: string, p: string, role?: AuthRole, passkeyAt?: number | null, pattern = { set: true, verifiedAt: Date.now() as number | null }) {
  let status = 200;
  let passed = false;
  let body: unknown;
  const req = { method, path: p, auth: role ? { userId: "u", email: null, role, rawRoles: [role], token: "t", passkeyAt, pattern } : undefined };
  const res = { status: (s: number) => ((status = s), { json: (b: unknown) => void (body = b) }) };
  enforceApiPolicy(req as never, res as never, () => {
    passed = true;
  });
  lastBody = body;
  return passed ? 200 : status;
}

test("enforcement: unlisted 404, anonymous 401, under-privileged 403, allowed passes", () => {
  assert.equal(run("GET", "/not/a/route", "admin"), 404);
  assert.equal(run("GET", "/feed/space-weather/latest"), 200);
  assert.equal(run("GET", "/feed/aurora/map"), 401);
  assert.equal(run("GET", "/feed/aurora/map", "user"), 200);
  assert.equal(run("GET", "/mesh/devices", "user"), 403);
  assert.equal(run("GET", "/mesh/devices", "staff"), 200);
  assert.equal(run("POST", "/rag/query", "staff"), 403);
  assert.equal(run("POST", "/rag/query", "operator"), 200);
  assert.equal(run("POST", "/security/cybertiger/block", "operator"), 403);
  assert.equal(run("POST", "/security/cybertiger/block", "admin", Date.now()), 200);
  assert.equal(run("OPTIONS", "/rag/query"), 200, "CORS preflight is never blocked");
});

test("admin changes need a passkey touch in the last 5 minutes, answered 428 (not 401/403) otherwise", () => {
  const now = Date.now();
  for (const [method, p] of [
    ["POST", "/admin/users/u-123/role"],
    ["POST", "/security/cybertiger/block"],
    ["POST", "/security/cybertiger/unblock"],
    ["POST", "/ai/nowcast/train"],
  ] as const) {
    assert.equal(run(method, p, "admin"), 428, `${p}: password-only session`);
    assert.deepEqual((lastBody as { code?: string }).code, STEP_UP_REQUIRED);
    assert.equal(run(method, p, "admin", now - STEP_UP_MAX_AGE_MS - 1000), 428, `${p}: touch too old`);
    assert.equal(run(method, p, "admin", now - 60_000), 200, `${p}: touched a minute ago`);
    assert.equal(run(method, p, "operator", now), 403, `${p}: a fresh touch never lifts the role check`);
    assert.equal(run(method, p), 401, `${p}: anonymous`);
  }
  // Reads stay one step: the admin roles list does not ask for a touch.
  assert.equal(run("GET", "/admin/users", "admin"), 200);
});

test("every admin-only change is marked step-up", () => {
  const unguarded = API_POLICY.filter((p) => p.access === "admin" && p.method !== "GET" && !p.stepUp);
  assert.deepEqual(unguarded.map((p) => `${p.method} ${p.path}`), []);
  assert.equal(policyFor("POST", "/admin/users/x/role")?.stepUp, true);
});

test("operator and admin routes need the operator pattern drawn in this session, answered 428 (not 401/403) otherwise", () => {
  const unset = { set: false, verifiedAt: null };
  const undrawn = { set: true, verifiedAt: null };
  for (const [method, p, role] of [
    ["POST", "/rag/query", "operator"],
    ["GET", "/swx/structures", "operator"],
    ["GET", "/admin/users", "admin"],
  ] as const) {
    assert.equal(run(method, p, role, null, unset), 428, `${p}: no pattern yet`);
    assert.equal((lastBody as { code?: string }).code, PATTERN_SETUP_REQUIRED);
    assert.equal(run(method, p, role, null, undrawn), 428, `${p}: pattern not drawn this session`);
    assert.equal((lastBody as { code?: string }).code, PATTERN_REQUIRED);
    assert.equal(run(method, p, role), 200, `${p}: drawn`);
  }
  // A missing pattern state (any context not built from a session) fails closed.
  const req = { method: "POST", path: "/rag/query", auth: { userId: "u", email: null, role: "operator", rawRoles: ["operator"], token: "t" } };
  let status = 0;
  enforceApiPolicy(req as never, { status: (s: number) => ((status = s), { json: () => undefined }) } as never, () => (status = 200));
  assert.equal(status, 428);
  // Viewer and staff routes, and the pattern routes themselves, never ask for it.
  assert.equal(run("GET", "/feed/aurora/map", "operator", null, unset), 200);
  assert.equal(run("GET", "/mesh/devices", "staff", null, unset), 200);
  assert.equal(run("POST", "/operator-pattern/verify", "operator", null, undrawn), 200);
  assert.equal(run("POST", "/operator-pattern/pad"), 200, "the phone's pad route is public");
  // A step-up route checks the pattern before the touch.
  assert.equal(run("POST", "/admin/users/x/role", "admin", Date.now(), undrawn), 428);
  assert.equal((lastBody as { code?: string }).code, PATTERN_REQUIRED);
  // OPERATOR_PATTERN=off turns it off.
  process.env.OPERATOR_PATTERN = "off";
  try {
    assert.equal(run("POST", "/rag/query", "operator", null, unset), 200);
  } finally {
    delete process.env.OPERATOR_PATTERN;
  }
});

test("setting the operator pattern needs a fresh passkey touch; drawing it does not", () => {
  assert.equal(policyFor("POST", "/operator-pattern")?.stepUp, true);
  assert.equal(policyFor("POST", "/operator-pattern/verify")?.stepUp, undefined);
  assert.equal(policyFor("POST", "/admin/users/x/pattern/clear")?.stepUp, true);
  assert.equal(accessFor("POST", "/operator-pattern/pad/info"), "public");
});
