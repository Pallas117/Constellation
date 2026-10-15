import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCanonicalPoint,
  decodeMhdState,
  encodeCanonicalPoint,
  encodeMhdState,
} from "./proto.js";

// Upgrade guard for protobufjs: shared/proto/telemetry.proto must keep loading,
// round-tripping and rejecting malformed wire data across dependency bumps.

test("MhdState round-trips through the telemetry schema", async () => {
  const state = {
    rho: 4.5,
    velocity: { x: -400, y: 12.5, z: 0.25 },
    magneticField: { x: 1.5, y: -2.25, z: 3 },
  };
  const decoded = await decodeMhdState(await encodeMhdState(state));
  assert.deepEqual(decoded.toJSON(), state);
});

test("CanonicalPoint round-trips nested messages", async () => {
  const point = {
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "noaa-swpc",
    rho: 6.5,
    velocity: { x: -420, y: 0.5, z: 1, magnitude: 420.5 },
    magneticField: { x: 2, y: -3.5, z: 1.25, bt: 4.5 },
  };
  const decoded = await decodeCanonicalPoint(await encodeCanonicalPoint(point));
  assert.deepEqual(decoded.toJSON(), point);
});

test("truncated wire data is rejected instead of decoding partially", async () => {
  const bytes = await encodeMhdState({ rho: 4.5, velocity: { x: 1, y: 2, z: 3 } });
  await assert.rejects(decodeMhdState(bytes.subarray(0, bytes.length - 2)), RangeError);
});
