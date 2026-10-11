export type DataSource =
  | "noaa-swpc"
  | "esa-hapi"
  | "jaxa-erg"
  | "mms-cdaweb"
  | "mms-lasp"
  | "model-nowcast"
  | "synthetic-nowcast";

export type ResilienceTier = 0 | 1 | 2 | 3; // 0: Live, 1: Buffered, 2: Synthetic, 3: Emergency/Stale

export interface QualityFlags {
  outlier: boolean;
  stale: boolean;
  interpolated: boolean;
  extrapolated: boolean;
  lowConfidence: boolean;
  tier: ResilienceTier;
}

export interface DeviceFingerprint {
  hash: string;
  buildAt: string;
  signals: Record<string, string | number>;
}

export interface DeviceTelemetry {
  temperatureC: number;
  batteryPercent: number;
  powerWatts: number;
  computeLoadPercent: number;
  networkLatencyMs: number;
  signalStrength?: number;
  lastReportedAt: string;
}

export interface DeviceSwapAssignment {
  deviceId: string;
  tier: "L1" | "L2" | "L3";
  recommendedLoadPercent: number;
  activeJobs: number;
  jobCapacity: number;
  score: number;
  reason: string;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  name?: string;
  fingerprintHash: string;
  fingerprintSignals?: Record<string, string | number>;
  registeredAt: string;
  lastSeen: string;
  status: "trusted" | "untrusted" | "needs_reauth";
  telemetry?: DeviceTelemetry;
  swap?: {
    tier: "L1" | "L2" | "L3";
    assignedLoadPercent: number;
    activeJobs: number;
    jobCapacity: number;
    updatedAt: string;
  };
  quality?: {
    score: number;
    sampleCount: number;
    networkStabilityMs: number;
    updatedAt: string;
  } | null;
}

export interface UncertaintyEnvelope {
  lower: number;
  upper: number;
  sigma: number;
}

export interface CanonicalSpaceWeatherPoint {
  timestamp: string;
  source: DataSource | "fusion";
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

export interface MMSTetrahedronQuality {
  valid: boolean;
  /** Tetrahedron volume, km^3. */
  volume: number;
  conditionNumber: number;
  divCurlRatio: number;
  confidence: "high" | "medium" | "low";
  reason?: string;
}

export interface MMSReconVectorPoint {
  timestamp: string;
  barycenterGsmRe: {
    x: number;
    y: number;
    z: number;
  };
  /** Curlometer current density, nA/m^2. */
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
  quality: MMSTetrahedronQuality;
}

export interface AuroraGridPoint {
  lat: number;
  lon: number;
  probability: number;
  energyFlux: number;
}

export interface SphericalHarmonicCoefficients {
  lMax: number;
  coefficients: Array<{ l: number; m: number; re: number; im: number }>;
  powerSpectrum: Array<{ l: number; cL: number }>;
}

export interface SourceStatus {
  source: DataSource;
  lastSeen: string | null;
  latencySeconds: number | null;
  healthy: boolean;
  message?: string;
}

export interface NowcastInferenceRequest {
  horizonMinutes: number;
  sequence: CanonicalSpaceWeatherPoint[];
}

export interface NowcastInferenceResponse {
  modelVersion: string;
  generatedAt: string;
  horizonMinutes: number;
  predictions: Array<{
    timestamp: string;
    geomagneticPerturbation: number;
    auroraIntensity: number;
    confidence: number;
  }>;
}

export interface AnomalyForecastResponse {
  modelVersion: string;
  generatedAt: string;
  horizonHours: number;
  anomalyProbability: number;
  predictedKpMax: number;
  warningMessage: string;
  confidenceInterval: [number, number];
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

export interface PipelineLatencySnapshot {
  generatedAt: string;
  /** fresh: live data, all stages in budget; degraded: ageing data or a stage over budget;
   *  stale: no measurement within maxAgeMs; stalled: the ingest loop itself stopped ticking. */
  status: "fresh" | "degraded" | "stale" | "stalled";
  tickIntervalMs: number;
  ticks: number;
  skippedTicks: number;
  lastTickAt: string | null;
  lastTickAgeMs: number | null;
  /** Timestamp and age of the newest real measurement feeding the nowcast. */
  dataTimestamp: string | null;
  dataAgeMs: number | null;
  freshMs: number;
  maxAgeMs: number;
  stages: PipelineStageLatency[];
}

export interface IngestionTickResult {
  canonicalPoint: CanonicalSpaceWeatherPoint | null;
  mmsVector: MMSReconVectorPoint | null;
  sourceStatus: SourceStatus[];
  auroraMap: {
    timestamp: string;
    nside: number;
    grid: AuroraGridPoint[];
    harmonics: SphericalHarmonicCoefficients;
  } | null;
  anomalyForecast?: AnomalyForecastResponse | null;
  pipeline?: PipelineLatencySnapshot;
}

