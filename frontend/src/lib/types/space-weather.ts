export interface QualityFlags {
  outlier: boolean;
  stale: boolean;
  interpolated: boolean;
  extrapolated: boolean;
  lowConfidence: boolean;
}

export interface UncertaintyEnvelope {
  lower: number;
  upper: number;
  sigma: number;
}

export interface CanonicalSpaceWeatherPoint {
  timestamp: string;
  source: string;
  rho: number;
  velocity: {
    x: number;
    y: number;
    z: number;
    magnitude: number;
  };
  magneticField: {
    x: number;
    y: number;
    z: number;
    bt: number;
  };
  electricField: {
    x: number;
    y: number;
    z: number;
    ey: number;
  };
  solarWind: {
    speed: number;
    density: number;
    dynamicPressure: number;
  };
  indices: {
    kp: number;
    dst: number;
  };
  coupling: {
    newell: number;
    epsilon: number;
  };
  propagation: {
    l1DelaySeconds: number;
    etaEarthArrival: string;
  };
  alerts: {
    stormTier: "quiet" | "watch" | "warning" | "severe";
    reason: string;
  };
  quality: QualityFlags;
  uncertainty: {
    speed: UncertaintyEnvelope;
    density: UncertaintyEnvelope;
    bz: UncertaintyEnvelope;
  };
}

export interface MMSReconVectorPoint {
  timestamp: string;
  barycenterGsmRe: {
    x: number;
    y: number;
    z: number;
  };
  currentDensity: {
    x: number;
    y: number;
    z: number;
    magnitude: number;
  };
  normal: {
    x: number;
    y: number;
    z: number;
  };
  lmn: {
    l: { x: number; y: number; z: number };
    m: { x: number; y: number; z: number };
    n: { x: number; y: number; z: number };
  };
  quality: {
    valid: boolean;
    volume: number;
    conditionNumber: number;
    divCurlRatio: number;
    confidence: "high" | "medium" | "low";
    reason?: string;
  };
}

export interface AuroraGridPoint {
  lat: number;
  lon: number;
  probability: number;
  energyFlux: number;
}

export interface AuroraMapResponse {
  timestamp: string;
  nside: number;
  grid: AuroraGridPoint[];
  harmonics: {
    lMax: number;
    coefficients: Array<{ l: number; m: number; re: number; im: number }>;
    powerSpectrum: Array<{ l: number; cL: number }>;
  };
}

export interface SourceStatus {
  source: string;
  lastSeen: string | null;
  latencySeconds: number | null;
  healthy: boolean;
  message?: string;
}
