import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { DeviceRecord } from "../types.js";
import { computeProof, deriveDeviceSecret, deviceAuthSecret, deviceProofsEnabled, verifyProof } from "./device-auth.js";

const device = { id: "dev-1", userId: "u1", fingerprintHash: "fp-1" } as DeviceRecord;
const strongKey = crypto.randomBytes(32).toString("hex");

function withKey(value: string | undefined, fn: () => void) {
  const saved = process.env.DEVICE_AUTH_SECRET;
  if (value === undefined) delete process.env.DEVICE_AUTH_SECRET;
  else process.env.DEVICE_AUTH_SECRET = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.DEVICE_AUTH_SECRET;
    else process.env.DEVICE_AUTH_SECRET = saved;
  }
}

// A proof signed the way the old code did when DEVICE_AUTH_SECRET was unset: with a key that is public.
function proofSignedWith(serverKey: string, nonce = "n1", timestamp = new Date().toISOString()) {
  const deviceSecret = crypto
    .createHmac("sha256", serverKey)
    .update(`${device.userId}:${device.id}:${device.fingerprintHash}`)
    .digest("hex");
  return computeProof(deviceSecret, nonce, timestamp);
}

test("without a usable key, device proofs are disabled and a forged proof never verifies (GAU-97)", () => {
  const forged = proofSignedWith("dev_device_secret_fallback");
  for (const value of [
    undefined,
    "",
    "too-short",
    "dev_device_secret_fallback",
    "replace-with-your-secret-or-leave-empty-for-dev",
  ]) {
    withKey(value, () => {
      assert.equal(deviceAuthSecret(), null, `key ${JSON.stringify(value)}`);
      assert.equal(deviceProofsEnabled(), false);
      assert.throws(() => deriveDeviceSecret(device.userId, device.id, device.fingerprintHash), /disabled/);
      assert.equal(verifyProof(device, forged.sig, forged.timestamp, forged.nonce), false);
    });
  }
});

test("with a configured key, genuine proofs verify and everything else is rejected without throwing", () => {
  withKey(strongKey, () => {
    assert.equal(deviceAuthSecret(), strongKey);
    const proof = computeProof(deriveDeviceSecret(device.userId, device.id, device.fingerprintHash), "n1", new Date().toISOString());
    assert.equal(verifyProof(device, proof.sig, proof.timestamp, proof.nonce), true);

    assert.equal(verifyProof(device, proof.sig, proof.timestamp, "other-nonce"), false);
    const flipped = (proof.sig[0] === "0" ? "1" : "0") + proof.sig.slice(1);
    assert.equal(verifyProof(device, flipped, proof.timestamp, proof.nonce), false);
    const forged = proofSignedWith("dev_device_secret_fallback");
    assert.equal(verifyProof(device, forged.sig, forged.timestamp, forged.nonce), false);

    for (const sig of ["", "zz", "abcd", proof.sig.slice(0, 63), `${proof.sig}00`, `${proof.sig}zz`, 42, null]) {
      assert.equal(verifyProof(device, sig as string, proof.timestamp, proof.nonce), false, `sig ${JSON.stringify(sig)}`);
    }

    const stale = computeProof(
      deriveDeviceSecret(device.userId, device.id, device.fingerprintHash),
      "n1",
      new Date(Date.now() - 10 * 60_000).toISOString(),
    );
    assert.equal(verifyProof(device, stale.sig, stale.timestamp, stale.nonce), false);
  });

  // Rotating the key invalidates proofs made with the old one.
  let oldProof!: ReturnType<typeof computeProof>;
  withKey(strongKey, () => {
    oldProof = computeProof(deriveDeviceSecret(device.userId, device.id, device.fingerprintHash), "n1", new Date().toISOString());
  });
  withKey(crypto.randomBytes(32).toString("hex"), () => {
    assert.equal(verifyProof(device, oldProof.sig, oldProof.timestamp, oldProof.nonce), false);
  });
});
