export type DataSource =
  | "noaa-swpc"
  | "esa-hapi"
  | "jaxa-erg"
  | "mms-cdaweb"
  | "mms-lasp"
  | "goes-swpc"
  | "kyoto-dst"
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

/** The solar wind reaching Earth now: L1 values one ballistic travel time ago, 5-min mean, GSM. */
export interface ArrivingSolarWind {
  /** Last L1 measurement in the mean. */
  observedAt: string;
  /** When it reached Earth. */
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
  /** When its L1 values were measured; freshness is judged from this. */
  observedAt?: string | null;
  /** L1 spacecraft the values came from. */
  spacecraft?: string;
  /** Null until 3 h of L1 history covers one travel time, or when the feed is lost. */
  arriving?: ArrivingSolarWind | null;
  densityCheck?: DensityDisagreement | null;
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
    /** "measured", or the model that derived dst (no source here measures Dst). GAU-63/GAU-84. */
    dstMethod: string;
    /** Canonical fields dst was derived from; empty when measured. */
    dstDerivedFrom: string[];
    /** "estimated-1m" (current) or "planetary-3h" (lags up to 3 h). */
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
    /** Bz-driven geomagnetic nowcast (mhd-nowcast stormTier). */
    stormTier: "quiet" | "watch" | "warning" | "severe";
    reason: string;
    /** NOAA S-scale from GOES ≥10 MeV protons: the radiation stream (bit errors, detector hits). */
    radiation?: ScaleReading;
    /** NOAA G-scale from planetary Kp: the geomagnetic stream (induced currents, drag, GNSS/HF). */
    geomagnetic?: ScaleReading;
    /** NOAA R-scale from GOES 0.1–0.8 nm X-rays: radio blackouts (dayside HF, GNSS). GAU-136. */
    radioBlackout?: ScaleReading;
  };
  /** Measured GOES long-band X-ray flux; null when missing or older than 15 min. GAU-136. */
  xray?: XrayReading | null;
  /** Input sense-checks for this point; a flagged input carries its reason. GAU-136. */
  senseChecks?: SenseCheck[];
  /** NOAA's own alerts, watches and warnings from the last 24 h, newest first; null when unreadable. GAU-136. */
  noaaAlerts?: NoaaAlert[] | null;
  quality: QualityFlags;
  /** Measured GOES particle flux; null per channel when missing or older than 30 min. */
  particles?: {
    protons: ParticleReading | null;
    electrons: ParticleReading | null;
  };
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

/** A level on a NOAA space-weather scale (physics/noaa-scales.ts). */
export interface ScaleReading {
  /** 0 = below the scale; null = unknown (input missing or stale), never "no storm". */
  level: 0 | 1 | 2 | 3 | 4 | 5 | null;
  /** "S2", "G0", or "S?" / "G?" when unknown. */
  label: string;
  /** What the level was read from, in words, e.g. "GOES >=10 MeV protons 152 pfu". */
  basis: string;
  /** When the input was measured (UTC); null when there was none. */
  observedAt: string | null;
}

/**
 * One sense-check on the inputs behind a point (GAU-136). A failed check is reported with
 * its reason and the sample stays visible; nothing is dropped silently.
 */
export interface SenseCheck {
  id: "l1-field-magnitude" | "goes-proton-spectrum" | "goes-proton-channels" | "goes-xray" | "noaa-scales";
  /** "unknown" when there was nothing current to check, never "pass". */
  status: "pass" | "flag" | "unknown";
  reason: string;
  /** Newest sample the check covered (UTC); null when there was none. */
  observedAt: string | null;
  /** Samples checked and flagged, for checks over a window. */
  checked?: number;
  flagged?: number;
}

export interface XrayReading {
  /** GOES 0.1–0.8 nm (1–8 Å) irradiance, W m^-2. */
  value: number;
  band: string;
  /** Flare class of the current flux, e.g. "B5.7", "M1.2", "X23". */
  flareClass: string;
  satellite: string | null;
  /** Measurement time (UTC). */
  timestamp: string;
}

export interface NoaaAlert {
  productId: string;
  issuedAt: string;
  /** The ALERT/WARNING/WATCH/SUMMARY line as NOAA wrote it. */
  headline: string;
}

export interface ParticleReading {
  /** Integral flux, particles cm^-2 s^-1 sr^-1 (pfu for protons). */
  value: number;
  /** Energy channel, e.g. ">=10 MeV". */
  energy: string;
  satellite: string | null;
  /** Measurement time (UTC). */
  timestamp: string;
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
  /** "model": trained weights. "heuristic": a fixed formula with no learned parameters. */
  method: "model" | "heuristic";
  generatedAt: string;
  horizonMinutes: number;
  predictions: Array<{
    timestamp: string;
    geomagneticPerturbation: number;
    auroraIntensity: number;
    /** null when the method has no calibrated confidence. */
    confidence: number | null;
  }>;
}

export interface AnomalyForecastAvailable {
  available: true;
  modelVersion: string;
  generatedAt: string;
  horizonHours: number;
  anomalyProbability: number;
  predictedKpMax: number;
  warningMessage: string;
  confidenceInterval: [number, number];
}

/** No trained model is deployed or it could not answer: say so instead of inventing a number. */
export interface AnomalyForecastUnavailable {
  available: false;
  modelVersion: null;
  generatedAt: string;
  horizonHours: number;
  reason: string;
}

export type AnomalyForecastResponse = AnomalyForecastAvailable | AnomalyForecastUnavailable;

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

