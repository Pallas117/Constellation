import assert from "node:assert/strict";
import test from "node:test";
import { roleFromUser, roleSatisfies } from "./auth.js";

test("users without a stored role are viewers, not admins", () => {
  assert.equal(roleFromUser({}), "viewer");
  assert.equal(roleFromUser(null), "viewer");
  assert.equal(roleFromUser({ role: "superuser" }), "viewer");
});

test("stored roles are honoured case-insensitively", () => {
  assert.equal(roleFromUser({ role: "operator" }), "operator");
  assert.equal(roleFromUser({ role: "ADMIN" }), "admin");
});

test("a viewer cannot satisfy an operator gate", () => {
  assert.equal(roleSatisfies(roleFromUser({}), "operator"), false);
  assert.equal(roleSatisfies(roleFromUser({ role: "operator" }), "operator"), true);
});
