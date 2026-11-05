/**
 * IGRF-14 main field (GAU-141): Earth's internal magnetic field at a position and date, from the
 * official IAGA coefficients (backend/physics/igrf14.json; CC BY 4.0, IAGA V-MOD; Beggan et al.,
 * Earth Planets Space 78, 127, doi:10.1186/s40623-025-02360-0).
 *
 * Coefficients are linear between the 2015, 2020 and 2025 epochs and follow the secular
 * variation after 2025, as IGRF prescribes; outside 2015.0–2030.0 the field is not computed.
 * Synthesis is the standard Schmidt semi-normalised spherical-harmonic expansion to degree 13
 * (Gauss-normalised Legendre recursion with Schmidt factors), in geocentric spherical
 * coordinates on the 6371.2 km reference sphere.
 */
import { readFileSync } from "node:fs";

interface IgrfData {
  referenceRadiusKm: number;
  epochs: [number, number, number];
  validFrom: number;
  validTo: number;
  /** [n, m, g2015, g2020, g2025, h2015, h2020, h2025, gSV, hSV] */
  terms: number[][];
}

const DATA = JSON.parse(readFileSync(new URL("./igrf14.json", import.meta.url), "utf8")) as IgrfData;
export const IGRF_VALID_FROM = DATA.validFrom;
export const IGRF_VALID_TO = DATA.validTo;
export const IGRF_LABEL = "IGRF-14 (IAGA V-MOD)";
const A = DATA.referenceRadiusKm;
const N = 13;

/** Coefficients g[n][m], h[n][m] in nT. */
export interface Coefficients {
  g: number[][];
  h: number[][];
}

/** Decimal year of a UTC time, e.g. 2026-07-02 ≈ 2026.5. */
export function decimalYear(ms: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  return y + (ms - start) / (Date.UTC(y + 1, 0, 1) - start);
}

/** IGRF-14 coefficients at a decimal year, or null outside 2015.0–2030.0. */
export function coefficientsAt(year: number): Coefficients | null {
  if (!(year >= DATA.validFrom && year <= DATA.validTo)) return null;
  const g = Array.from({ length: N + 1 }, () => new Array<number>(N + 1).fill(0));
  const h = Array.from({ length: N + 1 }, () => new Array<number>(N + 1).fill(0));
  const [e0, e1, e2] = DATA.epochs;
  for (const [n, m, g0, g1, g2, h0, h1, h2, gsv, hsv] of DATA.terms) {
    if (year <= e1) {
      const f = (year - e0) / (e1 - e0);
      g[n][m] = g0 + (g1 - g0) * f;
      h[n][m] = h0 + (h1 - h0) * f;
    } else if (year <= e2) {
      const f = (year - e1) / (e2 - e1);
      g[n][m] = g1 + (g2 - g1) * f;
      h[n][m] = h1 + (h2 - h1) * f;
    } else {
      g[n][m] = g2 + gsv * (year - e2);
      h[n][m] = h2 + hsv * (year - e2);
    }
  }
  return { g, h };
}

export interface FieldVector {
  /** Northward (−Bθ), eastward (Bφ) and downward (−Br) components, nT. */
  north: number;
  east: number;
  down: number;
  /** Total intensity |B|, nT. */
  total: number;
}

// Schmidt semi-normalisation factors S[n][m] (converting Gauss-normalised P to Schmidt).
const S: number[][] = (() => {
  const s = Array.from({ length: N + 1 }, () => new Array<number>(N + 1).fill(0));
  s[0][0] = 1;
  for (let n = 1; n <= N; n += 1) {
    s[n][0] = (s[n - 1][0] * (2 * n - 1)) / n;
    for (let m = 1; m <= n; m += 1) s[n][m] = s[n][m - 1] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
  }
  return s;
})();

/** The field of a coefficient set at geocentric latitude/longitude (degrees) and radius (km). */
export function synthesize(c: Coefficients, latDeg: number, lonDeg: number, radiusKm: number, maxDegree = N): FieldVector {
  const theta = ((90 - latDeg) * Math.PI) / 180;
  const phi = (lonDeg * Math.PI) / 180;
  const ct = Math.cos(theta);
  const st = Math.max(Math.sin(theta), 1e-10); // the poles are a limit, not a division by zero
  const P = Array.from({ length: maxDegree + 1 }, () => new Array<number>(maxDegree + 1).fill(0));
  const dP = Array.from({ length: maxDegree + 1 }, () => new Array<number>(maxDegree + 1).fill(0));
  P[0][0] = 1;
  for (let n = 1; n <= maxDegree; n += 1) {
    for (let m = 0; m <= n; m += 1) {
      if (n === m) {
        P[n][n] = st * P[n - 1][n - 1];
        dP[n][n] = st * dP[n - 1][n - 1] + ct * P[n - 1][n - 1];
      } else if (n === 1) {
        P[1][0] = ct;
        dP[1][0] = -st;
      } else {
        const k = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
        P[n][m] = ct * P[n - 1][m] - k * P[n - 2][m];
        dP[n][m] = ct * dP[n - 1][m] - st * P[n - 1][m] - k * dP[n - 2][m];
      }
    }
  }
  const ar = A / radiusKm;
  let br = 0;
  let bt = 0;
  let bp = 0;
  for (let n = 1; n <= maxDegree; n += 1) {
    const f = ar ** (n + 2);
    for (let m = 0; m <= n; m += 1) {
      const cm = Math.cos(m * phi);
      const sm = Math.sin(m * phi);
      const g = c.g[n][m];
      const h = c.h[n][m];
      const p = S[n][m] * P[n][m];
      const dp = S[n][m] * dP[n][m];
      br += (n + 1) * f * (g * cm + h * sm) * p;
      bt -= f * (g * cm + h * sm) * dp;
      bp -= f * m * (-g * sm + h * cm) * p;
    }
  }
  bp /= st;
  return { north: -bt, east: bp, down: -br, total: Math.hypot(br, bt, bp) };
}

/** IGRF-14 at a UTC time and geocentric position, or null outside the model's validity. */
export function igrfAt(ms: number, latDeg: number, lonDeg: number, radiusKm: number): FieldVector | null {
  const c = coefficientsAt(decimalYear(ms));
  return c ? synthesize(c, latDeg, lonDeg, radiusKm) : null;
}
