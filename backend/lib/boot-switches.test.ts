import assert from "node:assert/strict";
import test from "node:test";
import { bootSwitches, envSwitch } from "./boot-switches.js";

test("GAU-228: boot switches default to today's live behaviour, with the native kernel parked", () => {
  assert.deepEqual(bootSwitches({}), { swapTimer: true, mms: true, lasp: true, nativeMhd: false });
});

test("GAU-228: each boot switch turns on and off from the environment", () => {
  assert.deepEqual(
    bootSwitches({ GAUSS_SWAP_TIMER: "0", GAUSS_MMS: "off", GAUSS_LASP: "false", GAUSS_NATIVE_MHD: "true" }),
    { swapTimer: false, mms: false, lasp: false, nativeMhd: true },
  );
});

test("GAU-228: an unrecognised switch value keeps the default instead of guessing", () => {
  for (const raw of [undefined, "", "  ", "maybe", "2"]) {
    assert.equal(envSwitch(raw, true), true, String(raw));
    assert.equal(envSwitch(raw, false), false, String(raw));
  }
  assert.equal(envSwitch(" ON ", false), true, "trimmed and case-insensitive");
  assert.equal(envSwitch("No", true), false);
});
