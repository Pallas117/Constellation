/**
 * GET /api/swx/structures (operator): L1 structure candidates over the last 24 h. Mirrors
 * backend/physics/l1-structures.ts (GAU-139) and backend/adapters/noaa-swpc.ts (GAU-154).
 */
export type DetectionConfidence = "high" | "medium" | "low";

export interface ShockCandidate {
  kind: "fast-forward shock candidate";
  time: string;
  earthArrival: string;
  shockSpeedKmS: number;
  deltaSpeedKmS: number;
  densityRatio: number;
  fieldRatio: number;
  confidence: DetectionConfidence;
}

export interface FieldOnlyCandidate {
  kind: "field-only discontinuity (plasma not tracking)";
  time: string;
  fieldRatio: number;
  speedSpreadKmS: number;
  confidence: "low";
}

export interface SouthwardInterval {
  kind: "sustained southward driving";
  start: string;
  end: string;
  hours: number;
  maxEyMvM: number;
  minBzNt: number;
  confidence: DetectionConfidence;
}

export interface MagnetopauseInterval {
  kind: "magnetopause inside geostationary orbit";
  start: string;
  end: string;
  minutes: number;
  minStandoffRe: number;
  confidence: DetectionConfidence;
}

export interface IcmeInterval {
  kind: "ICME candidate";
  start: string;
  end: string;
  hours: number;
  signatures: ("low T/T_exp" | "low proton beta")[];
  medianTemperatureRatio: number;
  medianProtonBeta: number;
  minBzNt: number;
  maxBtNt: number;
  confidence: DetectionConfidence;
}

export interface FastFlowInterval {
  kind: "high-speed stream" | "post-shock fast flow (sheath / fast ejecta, not a coronal-hole stream)";
  start: string;
  end: string;
  hours: number;
  maxSpeedKmS: number;
  confidence: DetectionConfidence;
}

export interface L1Structures {
  shocks: ShockCandidate[];
  fieldOnlyDiscontinuities: FieldOnlyCandidate[];
  sustainedSouthward: SouthwardInterval[];
  magnetopauseInsideGeo: MagnetopauseInterval[];
  icmeCandidates: IcmeInterval[];
  fastFlows: FastFlowInterval[];
  coverage: { speed: number; density: number; bt: number; bz: number; temperature: number };
  notes: string[];
}

export interface LiveL1Structures {
  generatedAt: string;
  spacecraft: string;
  from: string;
  to: string;
  structures: L1Structures;
}

/** Before the backend's first L1 fetch there is nothing to show. */
export type L1StructuresResponse = LiveL1Structures | { structures: null; reason: string };
