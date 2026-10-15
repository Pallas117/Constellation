import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MESH_DEVICES_PATH,
  canUseMesh,
  meshDevicesPath,
  parseMeshDevices,
  parseMeshOnboarding,
  type MeshOnboarding,
} from "./mesh.ts";

const onboarding = (canEnroll: boolean): MeshOnboarding => ({
  steps: [],
  canEnroll,
  canSeeTeam: false,
  canRevokeAny: false,
  me: "u1",
});

describe("canUseMesh", () => {
  it("allows staff and above only, and never a signed-out visitor", () => {
    assert.equal(canUseMesh(false, null), false);
    assert.equal(canUseMesh(true, "user"), false);
    assert.equal(canUseMesh(true, "staff"), true);
    assert.equal(canUseMesh(true, "operator"), true);
    assert.equal(canUseMesh(true, "admin"), true);
  });
});

describe("meshDevicesPath", () => {
  it("asks for /devices only when the role allows it, onboarding is live and the server says canEnroll", () => {
    assert.equal(meshDevicesPath(true, true, onboarding(true)), MESH_DEVICES_PATH);
    assert.equal(meshDevicesPath(true, true, onboarding(false)), null, "server said no: a 403 would count in CyberTiger");
    assert.equal(meshDevicesPath(false, true, onboarding(true)), null, "held onboarding from another session doesn't count");
    assert.equal(meshDevicesPath(true, false, onboarding(true)), null, "onboarding stopped or failing: don't add a second 401");
    assert.equal(meshDevicesPath(true, true, null), null);
  });
});

describe("parseMeshOnboarding", () => {
  it("reads the onboarding body, treating anything but true as no permission", () => {
    const steps = [{ id: "install", title: "Install Argo", command: "brew install argo", detail: "" }];
    assert.deepEqual(
      parseMeshOnboarding({ ok: true, steps, me: "u1", canEnroll: true, canSeeTeam: "yes", canRevokeAny: 1 }),
      { steps, canEnroll: true, canSeeTeam: false, canRevokeAny: false, me: "u1" },
    );
    assert.deepEqual(parseMeshOnboarding({}), { steps: [], canEnroll: false, canSeeTeam: false, canRevokeAny: false, me: null });
    assert.throws(() => parseMeshOnboarding(null), /Invalid mesh onboarding format/);
  });
});

describe("parseMeshDevices", () => {
  it("returns the device list and rejects a body without one", () => {
    const devices = [{ name: "judith", enrolledAt: "2026-10-01T00:00:00.000Z", owner: "u1" }];
    assert.deepEqual(parseMeshDevices({ ok: true, devices }), devices);
    assert.throws(() => parseMeshDevices({ ok: true }), /Invalid mesh devices format/);
    assert.throws(() => parseMeshDevices(null), /Invalid mesh devices format/);
  });
});
