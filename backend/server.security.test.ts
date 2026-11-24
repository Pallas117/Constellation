import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { AuthRole } from "./auth.js";
import { API_POLICY, type Access } from "./rbac.js";

// Black-box security checks on the real app: the real CyberTiger, session guard, API_POLICY and
// routers, on an ephemeral loopback port (never :3001), with throwaway stores. Only the session
// lookup is stood in for (as in server.access.test.ts), so each request can pick its role.
// Requests carry no x-forwarded-for: CyberTiger sees a direct local client and never auto-blocks
// on the 401/403s below. Its rate limit still applies to local clients, so it is raised here.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gauss-server-security-"));
process.env.AUTH_REQUIRED = "true";
process.env.CYBERTIGER_RATE_LIMIT_MAX = "100000";
process.env.COMMERCE_DB_PATH = path.join(tmp, "commerce.db");
process.env.MESH_STORE_PATH = path.join(tmp, "mesh", "devices.json");
process.env.MESH_BUNDLE_PATH = path.join(tmp, "mesh", "bundles");
delete process.env.LOCAL_INFER_URL; // the nowcast uses the in-process heuristic

const { auth } = await import("./better-auth.js");
const { startBackend, stopBackend } = await import("./server.js");

const ROLES: AuthRole[] = ["user", "staff", "operator", "admin"];
let role: AuthRole | null = null;
let base = "";
let port = 0;
const api = auth.api as unknown as { getSession: (...args: unknown[]) => Promise<unknown> };
const realGetSession = api.getSession;

before(async () => {
  api.getSession = async () => (role ? { session: { token: "test-session" }, user: { id: `test-${role}`, email: `${role}@example.com`, role } } : null);
  const started = await startBackend({ host: "127.0.0.1", port: 0 });
  port = started.port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  api.getSession = realGetSession;
  await stopBackend();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

/** A raw HTTP request: unlike fetch, it sends the path exactly as written (no `..` or case folding). */
function raw(method: string, rawPath: string, as: AuthRole | null, body?: string, headers: Record<string, string> = {}): Promise<Reply> {
  role = as;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: rawPath, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** What no error answer may contain: stack frames, local paths, internals or environment. */
function assertNoLeak(reply: Reply, label: string) {
  for (const marker of ["    at ", "Error:", "TypeError", tmp, process.cwd(), os.homedir(), "node_modules", "BETTER_AUTH", "SECRET"]) {
    assert.equal(reply.body.includes(marker), false, `${label}: answer contains ${JSON.stringify(marker)}: ${reply.body.slice(0, 200)}`);
  }
}

const RANK: Record<AuthRole, number> = { user: 1, staff: 2, operator: 3, admin: 4 };
const below = (access: Access): AuthRole | null => (access === "public" ? null : (ROLES.filter((r) => RANK[r] < RANK[access]).pop() ?? null));

test("every API_POLICY route: no session is 401, the role just below is 403, public routes never ask for a session (REQ-SEC-023)", async () => {
  assert.ok(API_POLICY.length > 40, "the policy table was read");
  for (const { method, path: pattern, access } of API_POLICY) {
    const url = `/api${pattern.replace(/:\w+/g, "x")}`;
    const body = method === "GET" || method === "DELETE" ? undefined : "{}";
    const anonymous = await raw(method, url, null, body);
    if (access === "public") {
      assert.ok(![401, 403].includes(anonymous.status), `${method} ${url} is public but answered ${anonymous.status}`);
      continue;
    }
    assert.equal(anonymous.status, 401, `${method} ${url} without a session`);
    assertNoLeak(anonymous, `${method} ${url}`);
    const lower = below(access);
    if (lower) {
      const refused = await raw(method, url, lower, body);
      assert.equal(refused.status, 403, `${method} ${url} as ${lower} (needs ${access})`);
      assert.deepEqual(JSON.parse(refused.body), { error: `Requires ${access} role` });
    }
  }
});

test("path tricks never reach a route the policy did not admit for that role (REQ-SEC-023)", async () => {
  const cases: Array<[string, string, AuthRole | null, number]> = [
    // An operator route asked for by a user, spelled differently each time.
    ["GET", "/api/rag/status/", "user", 403], // trailing slash: same route, same policy
    ["GET", "/api/rag/status//", "user", 403],
    ["HEAD", "/api/security/cybertiger/events", "operator", 403], // HEAD is policed as GET
    ["GET", "/api/RAG/status", "user", 404], // Express routes ignore case; the policy does not, so unlisted
    ["GET", "/api/Security/CyberTiger/Events", "operator", 404],
    ["GET", "/api//rag/status", "user", 403], // double slash: the mount folds it, the policy still applies
    ["GET", "/api/rag%2fstatus", "user", 404], // encoded slash
    ["GET", "/api/rag/status;x=1", "user", 404],
    ["GET", "/api/rag/status%00", "user", 404],
    ["GET", "/api/feed/../rag/status", "user", 400], // traversal: CyberTiger refuses the request
    ["GET", "/api/feed/%2e%2e/rag/status", "user", 400],
    ["GET", "/api/feed/..%2frag/status", "user", 400],
    ["GET", "/api/device/..%2fswap/plan", "user", 400],
    // Unlisted routes, whatever the role and method.
    ["GET", "/api/admin", "admin", 404],
    ["PUT", "/api/device", "admin", 404],
    ["PATCH", "/api/security/cybertiger/block", "admin", 404],
    ["GET", "/api/security/cybertiger/block", "admin", 404], // POST-only
    ["POST", "/api/feed/space-weather/latest", "user", 404], // public is GET-only
    ["GET", "/api/.env", "admin", 404],
    ["GET", "/api/", "admin", 404],
    ["GET", "/api", "admin", 404],
    // Anonymous callers get 401 for unlisted paths too (the session check runs first), so a
    // scanner learns nothing about which routes exist, and CyberTiger counts every probe.
    ["GET", "/api/.env", null, 401],
    ["POST", "/api/feed/space-weather/latest", null, 401],
    ["GET", "/api/RAG/status", null, 401],
  ];
  for (const [method, url, as, want] of cases) {
    const reply = await raw(method, url, as);
    assert.equal(reply.status, want, `${method} ${url} as ${as ?? "anonymous"}`);
    assertNoLeak(reply, `${method} ${url}`);
  }
  // The device router's /:id must not turn "swap/plan" (operator) into a user-reachable id.
  const viaParam = await raw("GET", "/api/device/swap%2Fplan", "user");
  assert.equal(viaParam.status, 404);
});

test("security headers are on every kind of answer: ok, 400, 401, 403, 404, 413 and CyberTiger refusals (REQ-SEC-023)", async () => {
  const replies: Array<[string, Reply]> = [
    ["200 /health", await raw("GET", "/health", null)],
    ["200 public", await raw("GET", "/api/system/connectivity", null)],
    ["401", await raw("GET", "/api/feed/aurora/map", null)],
    ["403", await raw("GET", "/api/rag/status", "user")],
    ["404", await raw("GET", "/api/nope", "admin")],
    ["400 signature", await raw("GET", "/api/feed/../x", null)],
    ["400 invalid JSON", await raw("POST", "/api/rag/query", "operator", '{"query": ')],
    ["413 body", await raw("POST", "/api/rag/query", "operator", JSON.stringify({ query: "x".repeat(2 * 1024 * 1024 + 10) }))],
  ];
  for (const [label, reply] of replies) {
    assert.equal(reply.headers["x-content-type-options"], "nosniff", label);
    assert.equal(reply.headers["x-frame-options"], "DENY", label);
    assert.equal(reply.headers["referrer-policy"], "no-referrer", label);
    assert.match(String(reply.headers["content-security-policy"]), /default-src 'none'.*frame-ancestors 'none'/, label);
    assert.equal(reply.headers["x-powered-by"], undefined, label);
    assertNoLeak(reply, label);
  }
  assert.equal(replies[6][1].status, 400);
  assert.equal(replies[7][1].status, 413);
});

test("malformed input is a 400 with a fixed reason, never a 500 or an echo (REQ-SEC-023)", async () => {
  // Nowcast: a non-numeric horizon used to become NaN (empty prediction); a point without fields a 500.
  const badHorizon = await raw("POST", "/api/ai/nowcast/infer", "operator", JSON.stringify({ horizonMinutes: "soon" }));
  assert.equal(badHorizon.status, 400);
  const bareFields = await raw("POST", "/api/ai/nowcast/infer", "operator", JSON.stringify({ sequence: [{}], horizonMinutes: 30 }));
  assert.equal(bareFields.status, 200, bareFields.body);
  assert.equal((JSON.parse(bareFields.body) as { predictions: unknown[] }).predictions.length, 6);
  const notPoints = await raw("POST", "/api/ai/nowcast/infer", "operator", JSON.stringify({ sequence: [null, 3] }));
  assert.equal(notPoints.status, 400);

  // Aurora map: projection and ts are echoed and change the cache key; free text is refused.
  const probe = "<script>alert(1)</script>";
  const projection = await raw("GET", `/api/feed/aurora/map?projection=${encodeURIComponent(probe)}`, "user");
  assert.equal(projection.status, 400);
  assert.equal(projection.body.includes("<script"), false);
  assert.equal((await raw("GET", "/api/feed/aurora/map?ts=yesterday", "user")).status, 400);
  assert.equal((await raw("GET", "/api/feed/aurora/map?projection=a&projection=b", "user")).status, 400);

  // Device registration: oversized fields are refused.
  const register = await raw("POST", "/api/device/register", "user", JSON.stringify({ fingerprintHash: "f".repeat(5000) }));
  assert.equal(register.status, 400);

  for (const reply of [badHorizon, notPoints, projection, register]) assertNoLeak(reply, "malformed input");
});

test("admin block controls: a non-string or non-IP address is a 400 (was a TypeError 500); a huge duration no longer breaks status (REQ-SEC-022)", async () => {
  for (const body of [{ ip: 1234 }, { ip: ["1.2.3.4"] }, { ip: "not an ip" }, { ip: "1.2.3.4", reason: { x: 1 } }, { ip: "1.2.3.4", seconds: "forever" }]) {
    const reply = await raw("POST", "/api/security/cybertiger/block", "admin", JSON.stringify(body));
    assert.equal(reply.status, 400, JSON.stringify(body));
    assertNoLeak(reply, "block");
  }
  assert.equal((await raw("POST", "/api/security/cybertiger/unblock", "admin", JSON.stringify({ ip: 5 }))).status, 400);

  const long = await raw("POST", "/api/security/cybertiger/block", "admin", JSON.stringify({ ip: "203.0.113.77", reason: "test", seconds: 1e13 }));
  assert.equal(long.status, 200, long.body);
  const status = await raw("GET", "/api/security/cybertiger/status", "operator");
  assert.equal(status.status, 200, "status still answers after a very long block");
  assert.ok(status.body.includes("203.0.113.77"));
  assert.equal((await raw("POST", "/api/security/cybertiger/unblock", "admin", JSON.stringify({ ip: "203.0.113.77" }))).status, 200);
});

test("sign-in refuses a callback URL on another site (no open redirect) (REQ-SEC-023)", async () => {
  const reply = await raw(
    "POST",
    "/api/auth/sign-in/email",
    null,
    JSON.stringify({ email: "nobody@example.com", password: "a-long-test-password", callbackURL: "https://evil.example/landing" }),
    { origin: "http://localhost:8080" },
  );
  assert.equal(reply.status, 403, reply.body);
  assert.equal(reply.headers.location, undefined);
  assert.equal(reply.body.includes("evil.example"), false, "the hostile URL is not echoed");
});
