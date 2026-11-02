import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import Database from "better-sqlite3";
import express from "express";
import type { AuthenticatedRequest, AuthRole } from "../auth.js";
import { enforceApiPolicy } from "../rbac.js";
import { createAdminUsersRouter } from "./users.js";

function seed() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT);
           CREATE TABLE passkey (id TEXT PRIMARY KEY, userId TEXT, publicKey TEXT);`);
  const add = db.prepare("INSERT INTO user (id, name, email, role) VALUES (?, ?, ?, ?)");
  add.run("u-admin", "Ada", "ada@example.com", "admin");
  add.run("u-op", "Olu", "olu@example.com", "operator");
  add.run("u-new", "Nia", "nia@example.com", null);
  db.prepare("INSERT INTO passkey (id, userId, publicKey) VALUES (?, ?, ?)").run("pk1", "u-admin", "AQID");
  return db;
}

/** The production policy middleware, with the session faked from test headers. */
async function withApp(db: Database.Database, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use("/api", (req: AuthenticatedRequest, _res, next) => {
    const role = req.header("x-test-role") as AuthRole | undefined;
    const touched = req.header("x-test-touched-ms-ago");
    if (role) {
      req.auth = {
        userId: req.header("x-test-user") ?? "u-admin",
        email: null,
        role,
        rawRoles: [role],
        token: "t",
        passkeyAt: touched === undefined ? null : Date.now() - Number(touched),
      };
    }
    next();
  });
  app.use("/api", enforceApiPolicy);
  app.use("/api/admin/users", createAdminUsersRouter(db));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/users`);
  } finally {
    server.close();
  }
}

const setRole = (role: string, headers: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ role }),
});

test("admins list users with roles and passkey counts; nobody else can", async () => {
  await withApp(seed(), async (base) => {
    assert.equal((await fetch(base, { headers: { "x-test-role": "operator" } })).status, 403);
    const res = await fetch(base, { headers: { "x-test-role": "admin" } });
    assert.equal(res.status, 200);
    const { users } = (await res.json()) as { users: Array<{ id: string; role: string; passkeys: number }> };
    assert.deepEqual(
      users.map((u) => [u.id, u.role, u.passkeys]),
      [
        ["u-admin", "admin", 1],
        ["u-new", "user", 0],
        ["u-op", "operator", 0],
      ],
    );
    assert.equal(JSON.stringify(users).includes("AQID"), false, "no key material in the list");
  });
});

test("a role change needs an admin with a fresh passkey touch", async () => {
  const db = seed();
  await withApp(db, async (base) => {
    const stale = await fetch(`${base}/u-new/role`, setRole("operator", { "x-test-role": "admin" }));
    assert.equal(stale.status, 428, "password-only admin session: step up first");
    assert.equal(((await stale.json()) as { code: string }).code, "STEP_UP_REQUIRED");
    const old = await fetch(`${base}/u-new/role`, setRole("operator", { "x-test-role": "admin", "x-test-touched-ms-ago": "600000" }));
    assert.equal(old.status, 428, "a touch 10 minutes ago is too old");
    const operator = await fetch(`${base}/u-new/role`, setRole("admin", { "x-test-role": "operator", "x-test-touched-ms-ago": "0" }));
    assert.equal(operator.status, 403);

    const ok = await fetch(`${base}/u-new/role`, setRole("operator", { "x-test-role": "admin", "x-test-touched-ms-ago": "1000" }));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { id: "u-new", role: "operator", previous: "user" });
    assert.equal((db.prepare("SELECT role FROM user WHERE id = 'u-new'").get() as { role: string }).role, "operator");
  });
});

test("role changes refuse bad roles, self-changes and demoting the last admin", async () => {
  const db = seed();
  await withApp(db, async (base) => {
    const fresh = { "x-test-role": "admin", "x-test-touched-ms-ago": "0" };
    assert.equal((await fetch(`${base}/u-op/role`, setRole("root", fresh))).status, 400);
    assert.equal((await fetch(`${base}/nobody/role`, setRole("user", fresh))).status, 404);
    assert.equal((await fetch(`${base}/u-admin/role`, setRole("user", fresh))).status, 409, "no self-demotion");

    // Another admin session tries to demote u-admin, the only admin in the database.
    const other = { ...fresh, "x-test-user": "u-other" };
    assert.equal((await fetch(`${base}/u-admin/role`, setRole("operator", other))).status, 409, "the last admin stays an admin");
    assert.equal((db.prepare("SELECT role FROM user WHERE id = 'u-admin'").get() as { role: string }).role, "admin");

    // With a second admin in place, the demotion goes through.
    assert.equal((await fetch(`${base}/u-op/role`, setRole("admin", fresh))).status, 200);
    assert.equal((await fetch(`${base}/u-admin/role`, setRole("operator", other))).status, 200);
  });
});
