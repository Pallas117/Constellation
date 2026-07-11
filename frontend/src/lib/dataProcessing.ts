// ============================================================================
// DATA PROCESSING & INTERPOLATION ENGINE
// ============================================================================

export interface SpaceWeatherResponse {
  timestamp: string;
  solarWind: {
    speed: number;
    density: number;
    pressure: number;
  };
  imf: {
    bz: number;
    bt: number;
  };
  particles: {
    protonFlux: number;
    electronFlux: number;
  };
  indices: {
    kp: number;
    dst: number;
  };
  flags: {
    stale: boolean;
    source: 'live' | 'cache' | 'fallback';
    lastUpdate: string;
    tier?: number;
  };
}

export interface InterpolatedData {
  solarWind: {
    speed: number;
    density: number;
    pressure: number;
  };
  imfBz: number;
  kpIndex: number;
  protonFlux: number;
  electronFlux: number;
  timestamp: Date;
  isStale: boolean;
  source: string;
  tier: number;
}

// ============================================================================
// EXPONENTIAL MOVING AVERAGE (EMA) INTERPOLATION
// ============================================================================

export class EMAInterpolator {
  private current: InterpolatedData;
  private target: InterpolatedData;
  private startTime: number;
  private duration: number;

  constructor(initialData: InterpolatedData, duration: number = 8000) {
    this.current = { ...initialData };
    this.target = { ...initialData };
    this.startTime = Date.now();
    this.duration = duration;
  }

  setTarget(newTarget: InterpolatedData): void {
    // Transfer current interpolated values to starting point
    this.current = this.getInterpolated();
    this.target = { ...newTarget };
    this.startTime = Date.now();
  }

  getInterpolated(): InterpolatedData {
    const elapsed = Date.now() - this.startTime;
    const rawProgress = Math.min(1, elapsed / this.duration);
    
    // Exponential easing out (cubic)
    const t = 1 - Math.pow(1 - rawProgress, 3);

    return {
      solarWind: {
        speed: lerp(this.current.solarWind.speed, this.target.solarWind.speed, t),
        density: lerp(this.current.solarWind.density, this.target.solarWind.density, t),
        pressure: lerp(this.current.solarWind.pressure, this.target.solarWind.pressure, t),
      },
      imfBz: lerp(this.current.imfBz, this.target.imfBz, t),
      kpIndex: Math.round(lerp(this.current.kpIndex, this.target.kpIndex, t)),
      protonFlux: lerp(this.current.protonFlux, this.target.protonFlux, t),
      electronFlux: lerp(this.current.electronFlux, this.target.electronFlux, t),
      timestamp: this.target.timestamp,
      isStale: this.target.isStale,
      source: this.target.source,
      tier: this.target.tier,
    };
  }

  isComplete(): boolean {
    return Date.now() - this.startTime >= this.duration;
  }
}

// ============================================================================
// DECAY FUNCTION (for stale data)
// ============================================================================

const BASELINE = {
  solarWind: { speed: 400, density: 5, pressure: 2 },
  imfBz: 0,
  kpIndex: 3,
  protonFlux: 1,
  electronFlux: 2000,
};

const DECAY_HALF_LIFE = 5 * 60 * 1000; // 5 minutes

export function applyDecay(
  data: InterpolatedData,
  timeSinceUpdate: number
): InterpolatedData {
  if (timeSinceUpdate < DECAY_HALF_LIFE / 2) {
    return data; // No decay needed yet
  }

  const decayFactor = Math.exp(-timeSinceUpdate / DECAY_HALF_LIFE * Math.LN2);

  return {
    ...data,
    solarWind: {
      speed: decayToward(data.solarWind.speed, BASELINE.solarWind.speed, decayFactor),
      density: decayToward(data.solarWind.density, BASELINE.solarWind.density, decayFactor),
      pressure: decayToward(data.solarWind.pressure, BASELINE.solarWind.pressure, decayFactor),
    },
    imfBz: decayToward(data.imfBz, BASELINE.imfBz, decayFactor),
    kpIndex: Math.round(decayToward(data.kpIndex, BASELINE.kpIndex, decayFactor)),
    protonFlux: decayToward(data.protonFlux, BASELINE.protonFlux, decayFactor),
    electronFlux: decayToward(data.electronFlux, BASELINE.electronFlux, decayFactor),
  };
}

function decayToward(value: number, baseline: number, factor: number): number {
  return baseline + (value - baseline) * factor;
}

// ============================================================================
// DERIVED VISUALIZATION PARAMETERS
// ============================================================================

export interface VisualizationParams {
  magnetopauseCompression: number;  // 0.6-1.0 (1 = relaxed, 0.6 = compressed)
  beltIntensity: number;            // 0-1 (belt opacity/glow)
  reconnectionStrength: number;     // 0-1 (southward Bz effect)
  stormLevel: number;               // 0-1 (from Kp)
  tailStretch: number;              // 1-2 (magnetotail stretch factor)
}

export function calculateVisualizationParams(data: InterpolatedData): VisualizationParams {
  // Magnetopause compression based on dynamic pressure
  // Higher solar wind speed/density = more compression
  const pressureNorm = Math.min(1, data.solarWind.pressure / 10);
  const magnetopauseCompression = Math.max(0.6, 1 - pressureNorm * 0.4);

  // Belt intensity based on particle flux
  // Normalized log scale for better visual response
  const protonNorm = Math.min(1, Math.log10(data.protonFlux + 1) / 3);
  const electronNorm = Math.min(1, Math.log10(data.electronFlux + 1) / 6);
  const beltIntensity = Math.min(1, (protonNorm + electronNorm) / 2 + 0.2);

  // Reconnection strength based on southward Bz
  // Only active when Bz is negative (southward)
  const reconnectionStrength = Math.max(0, Math.min(1, -data.imfBz / 15));

  // Storm level from Kp index
  const stormLevel = data.kpIndex / 9;

  // Tail stretch increases with solar wind pressure
  const tailStretch = 1 + pressureNorm * 0.5;

  return {
    magnetopauseCompression,
    beltIntensity,
    reconnectionStrength,
    stormLevel,
    tailStretch,
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function transformApiResponse(response: SpaceWeatherResponse): InterpolatedData {
  return {
    solarWind: {
      speed: response.solarWind.speed,
      density: response.solarWind.density,
      pressure: response.solarWind.pressure,
    },
    imfBz: response.imf.bz,
    kpIndex: response.indices.kp,
    protonFlux: response.particles.protonFlux,
    electronFlux: response.particles.electronFlux,
    timestamp: new Date(response.timestamp),
    isStale: response.flags.stale,
    source: response.flags.source,
    tier: response.flags.tier ?? 0,
  };
}

// ============================================================================
// SCHEMA VALIDATION
// ============================================================================

export function validateSpaceWeatherResponse(data: unknown): SpaceWeatherResponse | null {
  if (!data || typeof data !== 'object') return null;
  
  const d = data as Record<string, unknown>;
  
  // Check required fields exist
  if (!d.timestamp || !d.solarWind || !d.imf || !d.particles || !d.indices || !d.flags) {
    return null;
  }

  const solarWind = d.solarWind as Record<string, unknown>;
  const imf = d.imf as Record<string, unknown>;
  const particles = d.particles as Record<string, unknown>;
  const indices = d.indices as Record<string, unknown>;
  const flags = d.flags as Record<string, unknown>;

  // Validate types
  if (
    typeof solarWind.speed !== 'number' ||
    typeof solarWind.density !== 'number' ||
    typeof imf.bz !== 'number' ||
    typeof particles.protonFlux !== 'number' ||
    typeof indices.kp !== 'number'
  ) {
    return null;
  }

  return data as SpaceWeatherResponse;
}
