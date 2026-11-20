import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createDeviceMemory, deviceHoursFrom } from "./device.js";

test("the pattern is remembered per passkey for 20 hours; duress and unusual access forget it", () => {
  let t = 1_800_000_000_000;
  const memory = createDeviceMemory(new Database(":memory:"), { hours: 20, now: () => t });
  assert.equal(memory.fresh("u1", "mac"), false);
  memory.remember("u1", "mac");
  memory.remember("u1", "phone");
  assert.equal(memory.fresh("u1", "mac"), true);
  assert.equal(memory.fresh("u1", "other"), false, "another passkey starts without it");
  assert.equal(memory.fresh("u2", "mac"), false, "another operator too");
  t += 19 * 3_600_000;
  assert.equal(memory.fresh("u1", "mac"), true);
  t += 2 * 3_600_000;
  assert.equal(memory.fresh("u1", "mac"), false, "gone after 20 hours");
  memory.remember("u1", "mac");
  memory.forget("u1", "mac");
  assert.deepEqual([memory.fresh("u1", "mac"), memory.fresh("u1", "phone")], [false, false], "the phone's ran out with the clock");
  memory.remember("u1", "mac");
  memory.remember("u1", "phone");
  memory.forget("u1");
  assert.deepEqual([memory.fresh("u1", "mac"), memory.fresh("u1", "phone")], [false, false], "duress forgets every passkey");
  memory.remember("u1", null);
  assert.equal(memory.fresh("u1", null), false, "a session not opened with a passkey is never remembered");
});

test("PATTERN_DEVICE_HOURS sets the window (0 turns it off, at most 24)", () => {
  assert.equal(deviceHoursFrom({}), 20);
  assert.equal(deviceHoursFrom({ PATTERN_DEVICE_HOURS: "0" }), 0);
  assert.equal(deviceHoursFrom({ PATTERN_DEVICE_HOURS: "8" }), 8);
  assert.equal(deviceHoursFrom({ PATTERN_DEVICE_HOURS: "72" }), 24);
  assert.equal(deviceHoursFrom({ PATTERN_DEVICE_HOURS: "soon" }), 20);
  const off = createDeviceMemory(new Database(":memory:"), { hours: 0 });
  off.remember("u1", "mac");
  assert.equal(off.fresh("u1", "mac"), false);
});
