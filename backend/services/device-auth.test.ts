import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { DeviceRecord } from "../types.js";
import {
  computeProof,
  deriveDeviceSecret,
  deviceAuthSecret,
  deviceProofsEnabled,
  MAX_LIVE_PROOFS_PER_DEVICE,
  verifyProof,
} from "./device-auth.js";

const device = { id: "dev-1", userId: "u1", fingerprintHash: "fp-1" } as DeviceRecord;
const strongKey = crypto.randomBytes(32).toString("hex");

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

const withKey = (value: string | undefined, fn: () => void) => withEnv("DEVICE_AUTH_SECRET", value, fn);

// A proof signed the way the old code did when DEVICE_AUTH_SECRET was unset: with a key that is public.
function proofSignedWith(serverKey: string, nonce = "n1", timestamp = Date.now().toString()) {
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
    const proof = computeProof(deriveDeviceSecret(device.userId, device.id, device.fingerprintHash), "n1");
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
      String(Date.now() - 10 * 60_000),
    );
    assert.equal(verifyProof(device, stale.sig, stale.timestamp, stale.nonce), false);
  });

  // Rotating the key invalidates proofs made with the old one.
  let oldProof!: ReturnType<typeof computeProof>;
  withKey(strongKey, () => {
    oldProof = computeProof(deriveDeviceSecret(device.userId, device.id, device.fingerprintHash), "n1");
  });
  withKey(crypto.randomBytes(32).toString("hex"), () => {
    assert.equal(verifyProof(device, oldProof.sig, oldProof.timestamp, oldProof.nonce), false);
  });
});

test("timestamps: only computeProof's epoch-ms format, within the TTL; a bad TTL setting can't disable the check (GAU-98)", () => {
  withKey(strongKey, () => {
    const secret = deriveDeviceSecret(device.userId, device.id, device.fingerprintHash);
    // A fresh nonce each time: proofs are single-use (GAU-99), and these share timestamps.
    const verifiesAt = (timestamp: string) => {
      const p = computeProof(secret, crypto.randomUUID(), timestamp);
      return verifyProof(device, p.sig, p.timestamp, p.nonce);
    };

    // computeProof's own default timestamp now verifies (Date.parse returned NaN for it).
    const p = computeProof(secret, "n1");
    assert.equal(verifyProof(device, p.sig, p.timestamp, p.nonce), true);

    // Correctly signed, but not the canonical format: rejected rather than parsed leniently.
    const now = Date.now();
    for (const ts of [new Date(now).toISOString(), "1", "Oct 11 2026", "-1", `${now}.5`, "1.7e12", ` ${now}`, "", "12345678901234567"]) {
      assert.equal(verifiesAt(ts), false, `timestamp ${JSON.stringify(ts)}`);
    }

    // Within the default 60 s either way, and not beyond it.
    assert.equal(verifiesAt(String(now - 30_000)), true);
    assert.equal(verifiesAt(String(now + 30_000)), true);
    assert.equal(verifiesAt(String(now - 90_000)), false);
    assert.equal(verifiesAt(String(now + 90_000)), false);

    const tenYearsAgo = String(now - 10 * 365 * 24 * 3600 * 1000);
    for (const bad of ["60s", "abc", "", "0", "-5", "Infinity"]) {
      withEnv("DEVICE_PROOF_TTL_MS", bad, () => {
        assert.equal(verifiesAt(tenYearsAgo), false, `DEVICE_PROOF_TTL_MS=${JSON.stringify(bad)}`);
        assert.equal(verifiesAt(String(now - 90_000)), false, `DEVICE_PROOF_TTL_MS=${JSON.stringify(bad)} falls back to 60 s`);
        assert.equal(verifiesAt(String(now - 30_000)), true);
      });
    }
    withEnv("DEVICE_PROOF_TTL_MS", "1000", () => assert.equal(verifiesAt(String(now - 5_000)), false));
    withEnv("DEVICE_PROOF_TTL_MS", "600000", () => assert.equal(verifiesAt(String(now - 5 * 60_000)), true));
  });
});

test("each proof is accepted once, uppercase copies included; a new nonce makes a new proof (GAU-99)", () => {
  withKey(strongKey, () => {
    const d = { ...device, id: "dev-replay" } as DeviceRecord;
    const secret = deriveDeviceSecret(d.userId, d.id, d.fingerprintHash);
    const p = computeProof(secret, "n1");
    assert.equal(verifyProof(d, p.sig, p.timestamp, p.nonce), true);
    assert.equal(verifyProof(d, p.sig, p.timestamp, p.nonce), false, "replayed");
    assert.equal(verifyProof(d, p.sig.toUpperCase(), p.timestamp, p.nonce), false, "uppercase copy of the same signature");

    const sameMs = computeProof(secret, "n2", p.timestamp);
    assert.equal(verifyProof(d, sameMs.sig, sameMs.timestamp, sameMs.nonce), true, "same millisecond, new nonce");

    // Only genuine proofs are remembered: a cap's worth of forgeries uses none of the device's cap.
    const next = computeProof(secret, "n3");
    for (let i = 0; i < MAX_LIVE_PROOFS_PER_DEVICE; i++) {
      assert.equal(verifyProof(d, crypto.randomBytes(32).toString("hex"), next.timestamp, next.nonce), false);
    }
    assert.equal(verifyProof(d, next.sig, next.timestamp, next.nonce), true);
  });
});

test("remembered proofs expire with the TTL, and a device's live-proof cap releases as they do (GAU-99)", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  withKey(strongKey, () => {
    const d = { ...device, id: "dev-cap" } as DeviceRecord;
    const other = { ...device, id: "dev-other" } as DeviceRecord;
    const fresh = (dev: DeviceRecord) => {
      const p = computeProof(deriveDeviceSecret(dev.userId, dev.id, dev.fingerprintHash), crypto.randomUUID());
      return { p, ok: verifyProof(dev, p.sig, p.timestamp, p.nonce) };
    };

    const first = fresh(d).p;
    for (let i = 1; i < MAX_LIVE_PROOFS_PER_DEVICE; i++) assert.equal(fresh(d).ok, true);
    assert.equal(fresh(d).ok, false, "over the live-proof cap: refused");
    assert.equal(fresh(other).ok, true, "other devices are unaffected");

    t.mock.timers.tick(60_001); // past the default TTL
    assert.equal(verifyProof(d, first.sig, first.timestamp, first.nonce), false, "an expired proof stays rejected");
    assert.equal(fresh(d).ok, true, "the cap releases once remembered proofs expire");
  });
});
