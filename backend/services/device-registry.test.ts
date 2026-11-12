import assert from "node:assert/strict";
import test from "node:test";
import {
  listDevices,
  MAX_DEVICES_PER_USER,
  MAX_SIGNAL_KEYS,
  MAX_SIGNAL_VALUE_LENGTH,
  registerDevice,
  updateDeviceStatus,
} from "./device-registry.js";

const owned = (userId: string) => listDevices().filter((device) => device.userId === userId);

test("logging in again from the same browser reuses its device record (GAU-209)", () => {
  const first = registerDevice("u-relogin", "fp-a", { ua: "Safari" }, "Laptop");
  for (let i = 0; i < 25; i += 1) registerDevice("u-relogin", "fp-a", { ua: "Safari" });
  const again = registerDevice("u-relogin", "fp-a", { ua: "Safari 2" }, "Work laptop");
  assert.equal(again.id, first.id);
  assert.equal(owned("u-relogin").length, 1);
  assert.equal(again.name, "Work laptop");
  assert.deepEqual(again.fingerprintSignals, { ua: "Safari 2" });
  assert.equal(again.registeredAt, first.registeredAt);

  // Another user with the same fingerprint gets their own record.
  assert.notEqual(registerDevice("u-other", "fp-a").id, first.id);
});

test("signing in again re-trusts needs_reauth but not untrusted (GAU-209)", () => {
  const device = registerDevice("u-status", "fp-s");
  updateDeviceStatus(device.id, { status: "needs_reauth" });
  assert.equal(registerDevice("u-status", "fp-s").status, "trusted");
  updateDeviceStatus(device.id, { status: "untrusted" });
  assert.equal(registerDevice("u-status", "fp-s").status, "untrusted");
});

test("devices per user are capped, evicting the least recently seen (GAU-209)", () => {
  const first = registerDevice("u-cap", "fp-0");
  for (let i = 1; i <= MAX_DEVICES_PER_USER + 5; i += 1) registerDevice("u-cap", `fp-${i}`);
  const devices = owned("u-cap");
  assert.equal(devices.length, MAX_DEVICES_PER_USER);
  assert.equal(devices.some((device) => device.id === first.id), false, "oldest evicted");
  assert.equal(devices.some((device) => device.fingerprintHash === `fp-${MAX_DEVICES_PER_USER + 5}`), true);
  assert.equal(owned("u-relogin").length <= 1, true, "other users untouched");
});

test("stored fingerprint signals are bounded (GAU-209)", () => {
  const huge: Record<string, unknown> = { nested: { a: 1 }, nan: Number.NaN, big: "x".repeat(1_000_000) };
  for (let i = 0; i < 10_000; i += 1) huge[`k${i}`] = i;
  const device = registerDevice("u-signals", "fp-big", huge as Record<string, string | number>);
  const signals = device.fingerprintSignals!;
  assert.equal(Object.keys(signals).length, MAX_SIGNAL_KEYS);
  assert.equal((signals.big as string).length, MAX_SIGNAL_VALUE_LENGTH);
  assert.equal("nested" in signals || "nan" in signals, false);

  updateDeviceStatus(device.id, { fingerprintSignals: huge as Record<string, string | number> });
  assert.equal(Object.keys(device.fingerprintSignals!).length, MAX_SIGNAL_KEYS);
});
