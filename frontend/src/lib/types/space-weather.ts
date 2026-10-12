export interface QualityFlags {
  outlier: boolean;
  stale: boolean;
  interpolated: boolean;
  extrapolated: boolean;
  lowConfidence: boolean;
  /** 0 live, 1 measured but ageing (10-15 min), 3 no measurement within 15 min. */
  tier?: number;
}

export interface UncertaintyEnvelope {
  lower: number;
  upper: number;
  sigma: number;
}

/** The solar wind reaching Earth now: L1 values one ballistic travel time ago, 5-min mean, GSM. */
export interface ArrivingSolarWind {
  observedAt: string;
  arrivedAt: string;
  travelSeconds: number;
  spacecraft: string;
  samples: number;
  bz: number;
  by: number;
  density: number;
  speed: number;
  dynamicPressure: number;
}

/** The operational spacecraft's density disagrees with another L1 spacecraft by more than 2x. */
export interface DensityDisagreement {
  spacecraft: string;
  density: number;
  reference: string;
  referenceDensity: number;
  ratio: number;
  minutes: number;
}

export interface CanonicalSpaceWeatherPoint {
  /** When the point was issued (5 s ingest tick). */
  timestamp: string;
  /** When its L1 values were measured; judge freshness from this. */
  observedAt?: string | null;
  spacecraft?: string;
  arriving?: ArrivingSolarWind | null;
  densityCheck?: DensityDisagreement | null;
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
    kpKind?: "estimated-1m" | "planetary-3h";
    kpObservedAt?: string | null;
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
