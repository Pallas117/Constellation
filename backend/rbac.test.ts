import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AuthRole } from "./auth.js";
import { accessFor, enforceApiPolicy, type Access } from "./rbac.js";

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
    ["GET", "/security/cybertiger/events", "admin"],
    ["POST", "/ai/nowcast/train", "admin"],
  ];
  for (const [m, p, want] of cases) assert.equal(accessFor(m, p), want, `${m} ${p}`);
  assert.equal(accessFor("POST", "/feed/space-weather/latest"), undefined, "public is GET-only");
  assert.equal(accessFor("GET", "/admin/secrets"), undefined);
});

function run(method: string, p: string, role?: AuthRole) {
  let status = 200;
  let passed = false;
  const req = { method, path: p, auth: role ? { userId: "u", email: null, role, rawRoles: [role], token: "t" } : undefined };
  const res = { status: (s: number) => ((status = s), { json: () => undefined }) };
  enforceApiPolicy(req as never, res as never, () => {
    passed = true;
  });
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
  assert.equal(run("POST", "/security/cybertiger/block", "admin"), 200);
  assert.equal(run("OPTIONS", "/rag/query"), 200, "CORS preflight is never blocked");
});
