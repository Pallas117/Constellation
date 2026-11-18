import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MESH_DEVICES_PATH,
  meshDevicesPath,
  parseMeshDevices,
  parseMeshOnboarding,
} from "./mesh.ts";

describe("parseMeshOnboarding", () => {
  it("reads steps and capability flags", () => {
    const steps = [{ id: "a", title: "Install", command: "argo init", detail: "d" }];
    const info = parseMeshOnboarding({ steps, canEnroll: true, canSeeTeam: false, canRevokeAny: true, me: "josh" });
    assert.deepEqual(info, { steps, canEnroll: true, canSeeTeam: false, canRevokeAny: true, me: "josh" });
  });

  it("treats missing or non-true flags as false and a missing me as null", () => {
    const info = parseMeshOnboarding({ canEnroll: "yes", me: 3 });
    assert.deepEqual(info, { steps: [], canEnroll: false, canSeeTeam: false, canRevokeAny: false, me: null });
  });

  it("throws on a non-object so the poller counts a failure", () => {
    assert.throws(() => parseMeshOnboarding(null), /Invalid mesh onboarding format/);
    assert.throws(() => parseMeshOnboarding("<html>"), /Invalid mesh onboarding format/);
  });
});

describe("parseMeshDevices", () => {
  it("returns the devices array", () => {
    const devices = [{ name: "mac", enrolledAt: "2026-11-01T00:00:00Z" }];
    assert.deepEqual(parseMeshDevices({ devices }), devices);
  });

  it("throws when devices is missing or not an array", () => {
    assert.throws(() => parseMeshDevices({}), /Invalid mesh devices format/);
    assert.throws(() => parseMeshDevices({ devices: "x" }), /Invalid mesh devices format/);
    assert.throws(() => parseMeshDevices(null), /Invalid mesh devices format/);
  });
});

describe("meshDevicesPath", () => {
  const info = (canEnroll: boolean) => ({ steps: [], canEnroll, canSeeTeam: false, canRevokeAny: false, me: null });

  it("asks for devices only when onboarding is live and allows enrolling", () => {
    assert.equal(meshDevicesPath(true, info(true)), MESH_DEVICES_PATH);
  });

  it("never polls /devices when it would draw a 403 or 401", () => {
    assert.equal(meshDevicesPath(true, info(false)), null);
    assert.equal(meshDevicesPath(false, info(true)), null);
    assert.equal(meshDevicesPath(true, null), null);
  });
});
