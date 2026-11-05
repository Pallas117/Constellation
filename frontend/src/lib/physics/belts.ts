/**
 * Van Allen belts as nested dipole L-shells (r = L cos²λ, Earth radii, scene
 * frame: x sunward, y north). Each shell is weighted by where the trapped
 * particles are, so the belts read as optically thin glow rather than a solid
 * surface. Brand Room / Gauss mark: protons in the inner belt (amber,
 * L ≈ 1.2–2.5), electrons in the outer belt (lime, L ≈ 3–6).
 */

export interface BeltSpec {
  lMin: number;
  lMax: number;
  /** Where the trapped flux peaks, and the Gaussian width around it (in L). */
  lPeak: number;
  lWidth: number;
  shells: number;
  /** Flux falls off along the field line as cos^latPower(λ). */
  latPower: number;
}

/** >10 MeV protons: a narrow inner belt peaking near L ≈ 1.5. */
export const PROTON_BELT: BeltSpec = { lMin: 1.2, lMax: 2.5, lPeak: 1.6, lWidth: 0.35, shells: 8, latPower: 6 };
/** MeV electrons: a broad outer belt peaking near L ≈ 4.5 in quiet times. */
export const ELECTRON_BELT: BeltSpec = { lMin: 3, lMax: 6, lPeak: 4.5, lWidth: 0.75, shells: 12, latPower: 4 };

/** Particles that reach the atmosphere (~100 km) are lost: shells stop there. */
const LOSS_RADIUS = 1.02;
/** How far the dayside of an L = 6 shell moves in at full compression (0.6). */
export const DAYSIDE_SQUEEZE = 0.25;

/** Magnetic latitude where the shell's field line reaches radius r: cos²λ = r / L. */
export const footLatitude = (L: number, r = 1) => Math.acos(Math.sqrt(Math.min(1, r / L)));

export interface BeltMesh {
  positions: Float32Array;
  /** Relative particle density at each vertex, 0..1. */
  weights: Float32Array;
  indices: Uint32Array;
}

/**
 * Shells for one belt. `compression` is the scene's magnetopause compression
 * (1 nominal, down to 0.6 under high solar wind pressure): the dayside of each
 * shell moves in and the nightside out, more for higher L.
 */
export function beltShells(spec: BeltSpec, lonSegments: number, latSegments: number, compression = 1): BeltMesh {
  const perShell = (latSegments + 1) * (lonSegments + 1);
  const positions = new Float32Array(spec.shells * perShell * 3);
  const weights = new Float32Array(spec.shells * perShell);
  const indices = new Uint32Array(spec.shells * latSegments * lonSegments * 6);
  const squeeze = (1 - Math.min(1, compression)) * DAYSIDE_SQUEEZE;
  let v = 0;
  let t = 0;
  for (let k = 0; k < spec.shells; k++) {
    const L = spec.lMin + ((k + 0.5) * (spec.lMax - spec.lMin)) / spec.shells;
    const shellWeight = Math.exp(-0.5 * ((L - spec.lPeak) / spec.lWidth) ** 2);
    const latMax = footLatitude(L, LOSS_RADIUS);
    const base = k * perShell;
    for (let i = 0; i <= latSegments; i++) {
      const lambda = (i / latSegments - 0.5) * 2 * latMax;
      const cosL = Math.cos(lambda);
      // Fade out over the last fifth before the loss radius.
      const toFoot = 1 - Math.abs(lambda) / latMax;
      const footFade = Math.min(1, toFoot / 0.2);
      const w = shellWeight * cosL ** spec.latPower * footFade * footFade * (3 - 2 * footFade);
      for (let j = 0; j <= lonSegments; j++) {
        const phi = (j / lonSegments) * Math.PI * 2;
        const cosPhi = Math.cos(phi);
        const r = L * cosL * cosL * (1 - squeeze * (L / 6) * cosPhi);
        positions[v * 3] = r * cosL * cosPhi;
        positions[v * 3 + 1] = r * Math.sin(lambda);
        positions[v * 3 + 2] = r * cosL * Math.sin(phi);
        weights[v] = w;
        v++;
      }
    }
    for (let i = 0; i < latSegments; i++) {
      for (let j = 0; j < lonSegments; j++) {
        const a = base + i * (lonSegments + 1) + j;
        const b = a + lonSegments + 1;
        indices.set([a, b, a + 1, a + 1, b, b + 1], t);
        t += 6;
      }
    }
  }
  return { positions, weights, indices };
}

export interface ParticleSpec {
  /** Mirror latitudes are drawn up to this fraction of the field line's foot latitude. */
  mirrorReach: number;
  /** Seconds per bounce (scene time, slowed for the eye) and per drift orbit. */
  bounceSeconds: number;
  driftSeconds: number;
  /** Gradient-curvature drift: +1 eastward (electrons), -1 westward (protons). */
  driftSign: 1 | -1;
}

/** Protons: pancake pitch angles keep them near the equator; they drift west. */
export const PROTON_PARTICLES: ParticleSpec = { mirrorReach: 0.55, bounceSeconds: 5, driftSeconds: 140, driftSign: -1 };
/** Electrons: wider bounce, eastward drift. */
export const ELECTRON_PARTICLES: ParticleSpec = { mirrorReach: 0.8, bounceSeconds: 3.5, driftSeconds: 90, driftSign: 1 };

export interface BeltParticles {
  count: number;
  l: Float32Array;
  /** Mirror latitude (rad): the particle bounces between ±mirror. */
  mirror: Float32Array;
  phase: Float32Array;
  lon: Float32Array;
  /** rad/s, signed for the drift direction. */
  bounceRate: Float32Array;
  driftRate: Float32Array;
}

/**
 * Every bounce and drift rate is a whole number of turns per this period, so the
 * shader can wrap its clock here without a jump (float32 time drifts over days).
 */
export const PARTICLE_PERIOD_S = 600;
const turnsPer = (seconds: number) => Math.max(1, Math.round(PARTICLE_PERIOD_S / seconds));
const TURN = (Math.PI * 2) / PARTICLE_PERIOD_S;

/** Deterministic PRNG so the scene looks the same on every load (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Trapped particles for one belt: L drawn from the belt's density profile,
 * mirror latitudes kept clear of the loss cone (they never reach the
 * atmosphere), bounce and drift rates varied ±25% so the motion never syncs up
 * (whole turns per PARTICLE_PERIOD_S).
 */
export function beltParticles(spec: BeltSpec, motion: ParticleSpec, count: number, seed: number): BeltParticles {
  const rand = random(seed);
  const out: BeltParticles = {
    count,
    l: new Float32Array(count),
    mirror: new Float32Array(count),
    phase: new Float32Array(count),
    lon: new Float32Array(count),
    bounceRate: new Float32Array(count),
    driftRate: new Float32Array(count),
  };
  for (let i = 0; i < count; i++) {
    let L: number;
    do {
      // Box-Muller around the peak, redrawn until it lands inside the belt.
      const g = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
      L = spec.lPeak + g * spec.lWidth;
    } while (L < spec.lMin || L > spec.lMax);
    out.l[i] = L;
    // Low mirror latitudes are commoner (more particles near the equator).
    out.mirror[i] = footLatitude(L, LOSS_RADIUS) * motion.mirrorReach * (0.15 + 0.85 * rand() ** 1.5);
    out.phase[i] = rand() * Math.PI * 2;
    out.lon[i] = rand() * Math.PI * 2;
    const vary = () => 0.75 + 0.5 * rand();
    out.bounceRate[i] = TURN * turnsPer(motion.bounceSeconds / vary());
    out.driftRate[i] = motion.driftSign * TURN * turnsPer(motion.driftSeconds / vary());
  }
  return out;
}

/**
 * Where particle i is at time t (scene frame, x sunward, y north, longitude
 * east-positive). The belt shader computes the same thing on the GPU.
 */
export function particlePosition(p: BeltParticles, i: number, t: number, compression = 1): [number, number, number] {
  const lambda = p.mirror[i] * Math.sin(p.phase[i] + p.bounceRate[i] * t);
  const lon = p.lon[i] + p.driftRate[i] * t;
  const cosL = Math.cos(lambda);
  const squeeze = (1 - Math.min(1, compression)) * DAYSIDE_SQUEEZE;
  const r = p.l[i] * cosL * cosL * (1 - squeeze * (p.l[i] / 6) * Math.cos(lon));
  return [r * cosL * Math.cos(lon), r * Math.sin(lambda), -r * cosL * Math.sin(lon)];
}
