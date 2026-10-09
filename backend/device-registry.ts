import express from "express";
import { roleSatisfies, type AuthenticatedRequest } from "./auth.js";
import {
  getDevice,
  listDevices,
  registerDevice,
  heartbeatDevice,
  updateDeviceQuality,
  updateDeviceStatus,
  updateDeviceTelemetry,
} from "./services/device-registry.js";
import { verifyProof } from "./services/device-auth.js";
import { createSwapPlan, rebalanceDeviceNetwork } from "./services/device-swap-manager.js";

const router = express.Router();

function isAdmin(req: AuthenticatedRequest): boolean {
  return req.auth ? roleSatisfies(req.auth.role, "admin") : false;
}

/**
 * Only the device's owner (or an admin) may touch it. Responds 404 rather than
 * 403 for other users' devices so device ids can't be probed.
 */
function requireOwnedDevice(req: AuthenticatedRequest, res: express.Response): boolean {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ ok: false, error: "Authentication required" });
    return false;
  }
  const device = getDevice(req.params.id);
  if (!device || (device.userId !== userId && !isAdmin(req))) {
    res.status(404).json({ ok: false, error: "Device not found" });
    return false;
  }
  return true;
}

router.get("/", (req: AuthenticatedRequest, res) => {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ ok: false, error: "Authentication required" });
    return;
  }
  const devices = listDevices();
  res.json({ ok: true, devices: isAdmin(req) ? devices : devices.filter((device) => device.userId === userId) });
});

router.post("/register", (req: AuthenticatedRequest, res) => {
  const userId = req.auth?.userId;
  if (!userId) {
    res.status(401).json({ ok: false, error: "Authentication required" });
    return;
  }

  const { fingerprintHash, fingerprintSignals, name } = req.body ?? {};
  if (!fingerprintHash || typeof fingerprintHash !== "string") {
    res.status(400).json({ ok: false, error: "Missing fingerprintHash" });
    return;
  }

  const device = registerDevice(userId, fingerprintHash, typeof fingerprintSignals === "object" ? fingerprintSignals : undefined, typeof name === "string" ? name : undefined);
  res.status(201).json({ ok: true, device });
});

router.post("/:id/heartbeat", (req: AuthenticatedRequest, res) => {
  if (!requireOwnedDevice(req, res)) return;
  const device = heartbeatDevice(req.params.id);
  if (!device) {
    res.status(404).json({ ok: false, error: "Device not found" });
    return;
  }
  res.json({ ok: true, device });
});

router.post("/:id/status", (req: AuthenticatedRequest, res) => {
  if (!requireOwnedDevice(req, res)) return;
  const { status, fingerprintHash, fingerprintSignals } = req.body ?? {};
  const device = updateDeviceStatus(req.params.id, { status, fingerprintHash, fingerprintSignals });
  if (!device) {
    res.status(404).json({ ok: false, error: "Device not found" });
    return;
  }
  res.json({ ok: true, device });
});

router.post("/:id/telemetry", (req: AuthenticatedRequest, res) => {
  if (!requireOwnedDevice(req, res)) return;
  const { temperatureC, batteryPercent, powerWatts, computeLoadPercent, networkLatencyMs, signalStrength } = req.body ?? {};
  if (
    typeof temperatureC !== "number" ||
    typeof batteryPercent !== "number" ||
    typeof powerWatts !== "number" ||
    typeof computeLoadPercent !== "number" ||
    typeof networkLatencyMs !== "number"
  ) {
    res.status(400).json({ ok: false, error: "Telemetry payload requires temperatureC, batteryPercent, powerWatts, computeLoadPercent, and networkLatencyMs" });
    return;
  }

  const telemetry = {
    temperatureC,
    batteryPercent,
    powerWatts,
    computeLoadPercent,
    networkLatencyMs,
    signalStrength: typeof signalStrength === "number" ? signalStrength : undefined,
    lastReportedAt: new Date().toISOString(),
  };

  const device = updateDeviceTelemetry(req.params.id, telemetry);
  if (!device) {
    res.status(404).json({ ok: false, error: "Device not found" });
    return;
  }
  res.json({ ok: true, device });
});

router.get("/swap/plan", (_req, res) => {
  const plan = createSwapPlan();
  res.json({ ok: true, plan });
});

router.post("/swap/rebalance", (req, res) => {
  const { requiredComputePercent, requiredPowerWatts, thermalThresholdC } = req.body ?? {};
  const response = rebalanceDeviceNetwork({ requiredComputePercent, requiredPowerWatts, thermalThresholdC });
  res.json({ ok: true, ...response });
});

router.post("/:id/quality", (req: AuthenticatedRequest, res) => {
  const { score, sampleCount, networkStabilityMs } = req.body ?? {};
  if (typeof score !== "number" || typeof networkStabilityMs !== "number") {
    res.status(400).json({ ok: false, error: "Invalid payload" });
    return;
  }
  const device = updateDeviceQuality(req.params.id, { score, sampleCount: Number(sampleCount ?? 1), networkStabilityMs });
  if (!device) {
    res.status(404).json({ ok: false, error: "Device not found" });
    return;
  }
  res.json({ ok: true, device });
});

router.post("/:id/proof", (req: AuthenticatedRequest, res) => {
  const { sig, timestamp, nonce } = req.body ?? {};
  if (!sig || !timestamp) {
    res.status(400).json({ ok: false, error: "Missing proof fields" });
    return;
  }

  const device = getDevice(req.params.id);
  if (!device) {
    res.status(404).json({ ok: false, error: "Device not found" });
    return;
  }

  const valid = verifyProof(device, sig, timestamp, typeof nonce === "string" ? nonce : "");
  if (!valid) {
    updateDeviceStatus(req.params.id, { status: "untrusted" });
    res.status(401).json({ ok: false, error: "Proof verification failed" });
    return;
  }

  updateDeviceStatus(req.params.id, { status: "trusted" });
  res.json({ ok: true, device });
});

router.get("/:id", (req: AuthenticatedRequest, res) => {
  const device = getDevice(req.params.id);
  if (!device) {
    res.status(404).json({ ok: false, error: "Device not found" });
    return;
  }
  res.json({ ok: true, device });
});

export default router;
