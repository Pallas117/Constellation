import { createRequire } from "module";
const require = createRequire(import.meta.url);

import type { CanonicalSpaceWeatherPoint, QualityFlags, UncertaintyEnvelope } from "../types.js";
import {
  clamp,
  cross,
  dot,
  gseToGsm,
  magnitude,
  vec,
  type Vector3,
} from "./coordinates.js";

let nativeMhd: any = null;
try {
  // Attempt to load the native C++ physics core if compiled
  nativeMhd = require("../../build/Release/mhd_native.node");
  console.log("[backend] Native C++ MHD kernel legacy bridge initialized");
} catch (e) {
  // Fallback to pure TS
}

const MU0 = 4e-7 * Math.PI;
const RE_METERS = 6_371_000;
const L0_METERS = 7 * RE_METERS;
const L1_DISTANCE_KM = 1_500_000;

export interface MhdInput {
  timestamp: string;
  source: CanonicalSpaceWeatherPoint["source"];
  density: number;
  velocityGse: Vector3;
  magneticFieldGse: Vector3;
  kp?: number;
  dst?: number;
}

export interface MhdState {
  rho: number;
  velocity: Vector3;
  magneticField: Vector3;
}

function dynamicPressureNpa(densityCm3: number, speedKmS: number): number {
  if (nativeMhd?.dynamicPressureNpa) {
    return nativeMhd.dynamicPressureNpa(densityCm3, speedKmS);
  }
  return 1.6726e-6 * densityCm3 * speedKmS * speedKmS;
}

function toTeslasFromNt(nt: number): number {
  return nt * 1e-9;
}

function newellCoupling(speedKmS: number, btNt: number, byNt: number, bzNt: number): number {
  if (nativeMhd?.newellCoupling) {
    return nativeMhd.newellCoupling(speedKmS, btNt, byNt, bzNt);
  }
  const thetaClock = Math.atan2(byNt, bzNt);
  const sinTerm = Math.sin(thetaClock / 2);
  const speedTerm = Math.pow(Math.max(speedKmS, 0), 4 / 3);
  const btTerm = Math.pow(Math.max(btNt, 0), 2 / 3);
  return speedTerm * btTerm * Math.pow(Math.max(sinTerm, 0), 8 / 3);
}

function akasofuEpsilon(speedKmS: number, btNt: number, byNt: number, bzNt: number): number {
  const thetaClock = Math.atan2(byNt, bzNt);
  const sinTerm = Math.pow(Math.sin(thetaClock / 2), 4);
  const speedMs = speedKmS * 1000;
  const btTesla = toTeslasFromNt(btNt);
  return (speedMs * btTesla * btTesla * sinTerm * L0_METERS * L0_METERS) / MU0;
}

function propagationDelaySeconds(speedKmS: number): number {
  const clamped = clamp(speedKmS, 250, 2000);
  return (L1_DISTANCE_KM / clamped);
}

function estimateDst(kp: number, bzNt: number, epsilon: number): number {
  // Burton-like proxy for nowcast feed; deterministic and bounded.
  const driving = -0.3 * Math.min(0, bzNt) - 0.04 * kp - 1.2e-7 * epsilon;
  return clamp(-20 + driving * 100, -400, 80);
}

function inducedElectricFieldMvM(velocityKmS: Vector3, magneticNt: Vector3): Vector3 {
  const vMs = vec(velocityKmS.x * 1000, velocityKmS.y * 1000, velocityKmS.z * 1000);
  const bTesla = vec(
    toTeslasFromNt(magneticNt.x),
    toTeslasFromNt(magneticNt.y),
    toTeslasFromNt(magneticNt.z),
  );
  const eVm = cross(vMs, bTesla);
  const minus = vec(-eVm.x, -eVm.y, -eVm.z);
  // Convert V/m to mV/m.
  return vec(minus.x * 1000, minus.y * 1000, minus.z * 1000);
}

function shueStandoffDistanceRe(dynamicPressure: number, bzNt: number): number {
  const r0 =
    (10.22 + 1.29 * Math.tanh(0.184 * (bzNt + 8.14))) * Math.pow(Math.max(dynamicPressure, 0.05), -1 / 6.6);
  return clamp(r0, 4, 25);
}

function stormTier(
  bzNt: number,
  kp: number,
  newell: number,
  newellP75: number,
  dstSlopeNtPerHr: number,
): { stormTier: "quiet" | "watch" | "warning" | "severe"; reason: string } {
  if (bzNt <= -10 && (kp >= 5 || dstSlopeNtPerHr <= -20)) {
    return { stormTier: "severe", reason: "Strong southward IMF with geomagnetic response" };
  }
  if (bzNt <= -5 && newell >= newellP75) {
    return { stormTier: "warning", reason: "Sustained southward IMF with elevated coupling" };
  }
  if (bzNt < 0) {
    return { stormTier: "watch", reason: "Southward IMF orientation detected" };
  }
  return { stormTier: "quiet", reason: "Nominal IMF orientation" };
}

function conservativeUpdate(prev: MhdState | null, input: MhdInput): MhdState {
  const gsmVelocity = gseToGsm(input.velocityGse, input.timestamp);
  const gsmMagnetic = gseToGsm(input.magneticFieldGse, input.timestamp);
  if (!prev) {
    return {
      rho: Math.max(0.01, input.density),
      velocity: gsmVelocity,
      magneticField: gsmMagnetic,
    };
  }

  // Lightweight conservative advection with divergence damping.
  const alpha = 0.35;
  const rho = clamp(alpha * input.density + (1 - alpha) * prev.rho, 0.01, 1000);
  const velocity = vec(
    alpha * gsmVelocity.x + (1 - alpha) * prev.velocity.x,
    alpha * gsmVelocity.y + (1 - alpha) * prev.velocity.y,
    alpha * gsmVelocity.z + (1 - alpha) * prev.velocity.z,
  );
  const magneticField = vec(
    alpha * gsmMagnetic.x + (1 - alpha) * prev.magneticField.x,
    alpha * gsmMagnetic.y + (1 - alpha) * prev.magneticField.y,
    alpha * gsmMagnetic.z + (1 - alpha) * prev.magneticField.z,
  );

  // Divergence projection in a lumped-cell approximation.
  const divBApprox = (magneticField.x + magneticField.y + magneticField.z) / 3;
  const projectedB = vec(
    magneticField.x - divBApprox,
    magneticField.y - divBApprox,
    magneticField.z - divBApprox,
  );

  return { rho, velocity, magneticField: projectedB };
}

function uncertainty(value: number, rel: number, floor = 0): UncertaintyEnvelope {
  const span = Math.max(Math.abs(value) * rel, floor);
  return {
    lower: value - span,
    upper: value + span,
    sigma: span / 2,
  };
}

function quality(flags: Partial<QualityFlags> = {}): QualityFlags {
  return {
    outlier: flags.outlier ?? false,
    stale: flags.stale ?? false,
    interpolated: flags.interpolated ?? false,
    extrapolated: flags.extrapolated ?? false,
    lowConfidence: flags.lowConfidence ?? false,
    tier: flags.tier ?? 0,
  };
}

export function computeCanonicalPoint(
  input: MhdInput,
  previousState: MhdState | null,
  couplingWindow: number[],
  previousDst: number | null,
): { point: CanonicalSpaceWeatherPoint; state: MhdState } {
  const state = conservativeUpdate(previousState, input);
  const speed = magnitude(state.velocity);
  const bt = magnitude(state.magneticField);
  const pdyn = dynamicPressureNpa(state.rho, speed);
  const electric = inducedElectricFieldMvM(state.velocity, state.magneticField);

  const newell = newellCoupling(speed, bt, state.magneticField.y, state.magneticField.z);
  const epsilon = akasofuEpsilon(speed, bt, state.magneticField.y, state.magneticField.z);
  const kp = clamp(input.kp ?? 2, 0, 9);
  const dst = input.dst ?? estimateDst(kp, state.magneticField.z, epsilon);
  const dstSlope = previousDst == null ? 0 : (dst - previousDst) * 12;

  const sorted = [...couplingWindow].sort((a, b) => a - b);
  const p75 = sorted.length > 0 ? sorted[Math.floor(0.75 * (sorted.length - 1))] : newell;
  const alert = stormTier(state.magneticField.z, kp, newell, p75, dstSlope);

  const delaySec = propagationDelaySeconds(speed);
  const eta = new Date(Date.parse(input.timestamp) + delaySec * 1000).toISOString();

  const point: CanonicalSpaceWeatherPoint = {
    timestamp: input.timestamp,
    source: input.source,
    rho: state.rho,
    velocity: {
      x: state.velocity.x,
      y: state.velocity.y,
      z: state.velocity.z,
      magnitude: speed,
    },
    magneticField: {
      x: state.magneticField.x,
      y: state.magneticField.y,
      z: state.magneticField.z,
      bt,
    },
    electricField: {
      x: electric.x,
      y: electric.y,
      z: electric.z,
      ey: electric.y,
    },
    solarWind: {
      speed,
      density: state.rho,
      dynamicPressure: pdyn,
    },
    indices: {
      kp,
      dst,
    },
    coupling: {
      newell,
      epsilon,
    },
    propagation: {
      l1DelaySeconds: delaySec,
      etaEarthArrival: eta,
    },
    alerts: {
      stormTier: alert.stormTier,
      reason: alert.reason,
    },
    quality: quality(),
    uncertainty: {
      speed: uncertainty(speed, 0.08, 8),
      density: uncertainty(state.rho, 0.12, 0.3),
      bz: uncertainty(state.magneticField.z, 0.2, 0.5),
    },
  };

  // Include Shue standoff as hidden diagnostics in reason text for lightweight compatibility.
  const r0 = shueStandoffDistanceRe(pdyn, state.magneticField.z);
  point.alerts.reason = `${point.alerts.reason}; r0=${r0.toFixed(2)} Re`;

  return { point, state };
}

export function mhdResidualNorm(previous: MhdState | null, current: MhdState): number {
  if (!previous) {
    return 0;
  }
  const drho = current.rho - previous.rho;
  const dv = current.velocity;
  const db = current.magneticField;
  return Math.sqrt(drho * drho + dot(dv, dv) + dot(db, db));
}
