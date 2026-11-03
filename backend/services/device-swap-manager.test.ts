import assert from "node:assert/strict";
import test from "node:test";
import { registerDevice } from "./device-registry.js";
import { scheduledRebalance } from "./device-swap-manager.js";

test("GAU-228: the swap timer's tick does nothing until a device is registered, then rebalances it", () => {
  assert.equal(scheduledRebalance(), null, "no devices: nothing planned, nothing written");
  const device = registerDevice("user_1", "fingerprint-hash");
  const result = scheduledRebalance();
  assert.ok(result, "a registered device is rebalanced");
  assert.equal(result.plan.summary.totalDevices, 1);
  assert.equal(result.plan.assignments[0]?.deviceId, device.id);
});
