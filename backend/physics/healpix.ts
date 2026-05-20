import type {
  AuroraGridPoint,
  CanonicalSpaceWeatherPoint,
  SphericalHarmonicCoefficients,
} from "../types.js";

const DEG_TO_RAD = Math.PI / 180;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function factorial(n: number): number {
  let v = 1;
  for (let i = 2; i <= n; i += 1) {
    v *= i;
  }
  return v;
}

function associatedLegendre(l: number, m: number, x: number): number {
  if (m > l) return 0;
  let pmm = 1;
  if (m > 0) {
    const somx2 = Math.sqrt((1 - x) * (1 + x));
    let fact = 1;
    for (let i = 1; i <= m; i += 1) {
      pmm *= -fact * somx2;
      fact += 2;
    }
  }
  if (l === m) return pmm;
  let pmmp1 = x * (2 * m + 1) * pmm;
  if (l === m + 1) return pmmp1;
  let pll = 0;
  for (let ll = m + 2; ll <= l; ll += 1) {
    pll = ((2 * ll - 1) * x * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
    pmm = pmmp1;
    pmmp1 = pll;
  }
  return pll;
}

function realSphericalHarmonic(l: number, m: number, theta: number, phi: number): number {
  const absM = Math.abs(m);
  const norm = Math.sqrt(
    ((2 * l + 1) / (4 * Math.PI)) * (factorial(l - absM) / factorial(l + absM)),
  );
  const p = associatedLegendre(l, absM, Math.cos(theta));
  if (m > 0) return Math.sqrt(2) * norm * p * Math.cos(absM * phi);
  if (m < 0) return Math.sqrt(2) * norm * p * Math.sin(absM * phi);
  return norm * p;
}

function targetPixelCount(nside: number): number {
  return 12 * nside * nside;
}

function pseudoHealpixIndex(lat: number, lon: number, nside: number): number {
  // Practical pseudo-HEALPix binning to avoid heavy dependency.
  const nLat = nside * 3;
  const nLon = nside * 4;
  const latIdx = clamp(Math.floor(((lat + 90) / 180) * nLat), 0, nLat - 1);
  const lonIdx = clamp(Math.floor((((lon + 180) % 360) / 360) * nLon), 0, nLon - 1);
  return latIdx * nLon + lonIdx;
}

export function buildAuroraGrid(
  canonical: CanonicalSpaceWeatherPoint,
  nside = 64,
): { grid: AuroraGridPoint[]; harmonics: SphericalHarmonicCoefficients } {
  const pixelCount = targetPixelCount(nside);
  const pixelFlux = new Array<number>(pixelCount).fill(0);
  const pixelHits = new Array<number>(pixelCount).fill(0);

  const kpScale = canonical.indices.kp / 9;
  const bzSouth = Math.max(0, -canonical.magneticField.z);
  const coupling = canonical.coupling.newell;

  // Build synthetic global probability distribution parameterized by drivers.
  for (let lat = -89.5; lat <= 89.5; lat += 1) {
    for (let lon = -179.5; lon <= 179.5; lon += 1) {
      const ovalCenter = 67 - kpScale * 18;
      const hemiDistance = Math.abs(Math.abs(lat) - ovalCenter);
      const lonMod = 0.5 + 0.5 * Math.cos((lon + canonical.electricField.ey * 6) * DEG_TO_RAD);
      const base = Math.exp(-0.5 * Math.pow(hemiDistance / 8, 2));
      const probability = clamp(base * (0.2 + 0.8 * kpScale) * (0.4 + 0.6 * lonMod), 0, 1);
      const energyFlux = probability * (1 + bzSouth / 20) * (1 + coupling / 15000) * 5;

      const idx = pseudoHealpixIndex(lat, lon, nside) % pixelCount;
      pixelFlux[idx] += energyFlux;
      pixelHits[idx] += 1;
    }
  }

  const grid: AuroraGridPoint[] = [];
  const nLat = nside * 3;
  const nLon = nside * 4;
  for (let i = 0; i < pixelCount; i += 1) {
    const avgFlux = pixelHits[i] > 0 ? pixelFlux[i] / pixelHits[i] : 0;
    const latIdx = Math.floor(i / nLon);
    const lonIdx = i % nLon;
    const lat = (latIdx + 0.5) * (180 / nLat) - 90;
    const lon = (lonIdx + 0.5) * (360 / nLon) - 180;
    grid.push({
      lat,
      lon,
      probability: clamp(avgFlux / 5, 0, 1),
      energyFlux: avgFlux,
    });
  }

  const harmonics = sphericalHarmonics(grid, 8);
  return { grid, harmonics };
}

export function sphericalHarmonics(
  grid: AuroraGridPoint[],
  lMax = 8,
): SphericalHarmonicCoefficients {
  const coefficients: Array<{ l: number; m: number; re: number; im: number }> = [];
  const powerSpectrum: Array<{ l: number; cL: number }> = [];

  for (let l = 0; l <= lMax; l += 1) {
    let cLAccum = 0;
    for (let m = -l; m <= l; m += 1) {
      let re = 0;
      let im = 0;
      for (const point of grid) {
        const theta = (90 - point.lat) * DEG_TO_RAD;
        const phi = point.lon * DEG_TO_RAD;
        const ylm = realSphericalHarmonic(l, m, theta, phi);
        re += point.energyFlux * ylm;
        im += 0;
      }
      re /= grid.length;
      coefficients.push({ l, m, re, im });
      cLAccum += re * re + im * im;
    }
    powerSpectrum.push({
      l,
      cL: cLAccum / (2 * l + 1),
    });
  }

  return { lMax, coefficients, powerSpectrum };
}
