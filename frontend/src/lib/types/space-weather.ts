export interface QualityFlags {
  outlier: boolean;
  stale: boolean;
  interpolated: boolean;
  extrapolated: boolean;
  lowConfidence: boolean;
  /** 0 live, 1 measured but ageing (10-15 min), 3 no measurement within 15 min. 2 is not emitted. */
  tier?: 0 | 1 | 2 | 3;
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

/** A level on a NOAA space-weather scale, from the backend (physics/noaa-scales.ts). */
export interface ScaleReading {
  /** 0 = below the scale; null = unknown (input missing or stale), never "no storm". */
  level: 0 | 1 | 2 | 3 | 4 | 5 | null;
  /** "S2", "G0", or "S?" / "G?" when unknown. */
  label: string;
  /** What the level was read from, e.g. "GOES >=10 MeV protons 152 pfu". */
  basis: string;
  observedAt: string | null;
}

/** One input sense-check (GAU-136); mirrors backend/types.ts. */
export interface SenseCheck {
  id: "l1-field-magnitude" | "goes-proton-spectrum" | "goes-proton-channels" | "goes-xray" | "noaa-scales";
  /** "unknown" when there was nothing current to check, never "pass". */
  status: "pass" | "flag" | "unknown";
  reason: string;
  observedAt: string | null;
  checked?: number;
  flagged?: number;
}

export interface XrayReading {
  /** GOES 0.1–0.8 nm irradiance, W m^-2. */
  value: number;
  band: string;
  flareClass: string;
  satellite: string | null;
  timestamp: string;
}

export interface NoaaAlert {
  productId: string;
  issuedAt: string;
  headline: string;
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
    dstObservedAt?: string | null;
  };
  /** Values not measured as published, with the method and inputs (GAU-63). */
  derived?: Array<{ field: string; method: string; derivedFrom: string[] }>;
  coupling: {
    newell: number;
    epsilon: number;
  };
  propagation: {
    l1DelaySeconds: number;
    etaEarthArrival: string;
  };
  alerts: {
    /** Bz-driven geomagnetic nowcast. */
    stormTier: "quiet" | "watch" | "warning" | "severe";
    reason: string;
    /** NOAA S-scale from GOES ≥10 MeV protons: the radiation stream (bit errors, detector hits). */
    radiation?: ScaleReading;
    /** NOAA G-scale from planetary Kp: the geomagnetic stream. */
    geomagnetic?: ScaleReading;
    /** NOAA R-scale from GOES X-rays: radio blackouts. */
    radioBlackout?: ScaleReading;
  };
  /** GOES long-band X-ray flux; null when missing or older than 15 min. */
  xray?: XrayReading | null;
  /** Input sense-checks; a flagged input carries its reason. */
  senseChecks?: SenseCheck[];
  /** NOAA alerts from the last 24 h, newest first; null when unreadable. */
  noaaAlerts?: NoaaAlert[] | null;
  /** Measured GOES particle flux; null per channel when missing or older than 30 min. */
  particles?: {
    protons: ParticleReading | null;
    electrons: ParticleReading | null;
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

export interface PipelineStageLatency {
  stage: string;
  lastMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  budgetMs: number | null;
  overBudget: boolean;
  samples: number;
  errors: number;
  timeouts: number;
  lastAt: string;
}

/** Mirrors backend PipelineLatencySnapshot (GET /api/system/pipeline). */
export interface PipelineLatencySnapshot {
  generatedAt: string;
  status: "fresh" | "degraded" | "stale" | "stalled";
  tickIntervalMs: number;
  ticks: number;
  skippedTicks: number;
  lastTickAt: string | null;
  lastTickAgeMs: number | null;
  dataTimestamp: string | null;
  dataAgeMs: number | null;
  freshMs: number;
  maxAgeMs: number;
  stages: PipelineStageLatency[];
}

export interface ParticleReading {
  /** Integral flux, particles cm^-2 s^-1 sr^-1 (pfu for protons). */
  value: number;
  energy: string;
  satellite: string | null;
  timestamp: string;
}
