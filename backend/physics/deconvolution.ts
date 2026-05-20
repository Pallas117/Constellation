export interface DeconvolutionInput {
  mappingMatrix: number[][];
  noiseCovDiagonal: number[];
  observation: number[];
  lambda: number;
  tolerance?: number;
  maxIterations?: number;
}

export interface DeconvolutionResult {
  signal: number[];
  iterations: number;
  residualNorm: number;
  converged: boolean;
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function matVec(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) => dot(row, vector));
}

function transpose(matrix: number[][]): number[][] {
  if (matrix.length === 0) return [];
  const rows = matrix.length;
  const cols = matrix[0].length;
  const t = Array.from({ length: cols }, () => new Array<number>(rows).fill(0));
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      t[c][r] = matrix[r][c];
    }
  }
  return t;
}

function add(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + (b[i] ?? 0));
}

function sub(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - (b[i] ?? 0));
}

function scale(v: number[], k: number): number[] {
  return v.map((x) => x * k);
}

function applyNInv(diag: number[], vector: number[]): number[] {
  return vector.map((v, i) => v / Math.max(diag[i] ?? 1, 1e-9));
}

function buildSystem(input: DeconvolutionInput): {
  applyA: (x: number[]) => number[];
  b: number[];
  preconditioner: number[];
} {
  const mt = transpose(input.mappingMatrix);
  const nInvD = input.noiseCovDiagonal;

  const nInvDamped = nInvD.map((v) => Math.max(v, 1e-9));

  const b = matVec(mt, applyNInv(nInvDamped, input.observation));

  const applyA = (x: number[]): number[] => {
    const mx = matVec(input.mappingMatrix, x);
    const nInvMx = applyNInv(nInvDamped, mx);
    const mtNInvMx = matVec(mt, nInvMx);
    return mtNInvMx.map((v, i) => v + input.lambda * (x[i] ?? 0));
  };

  // Diagonal preconditioner approximation for CG.
  const preconditioner = mt.map((row, i) => {
    let diagValue = 0;
    for (let k = 0; k < row.length; k += 1) {
      diagValue += row[k] * row[k] / Math.max(nInvDamped[k] ?? 1, 1e-9);
    }
    return 1 / Math.max(diagValue + input.lambda, 1e-9);
  });

  return { applyA, b, preconditioner };
}

export function regularizedDeconvolution(input: DeconvolutionInput): DeconvolutionResult {
  const tol = input.tolerance ?? 1e-6;
  const maxIter = input.maxIterations ?? 200;
  const n = input.mappingMatrix[0]?.length ?? 0;
  const { applyA, b, preconditioner } = buildSystem(input);

  let x = new Array<number>(n).fill(0);
  let r = sub(b, applyA(x));
  let z = r.map((v, i) => v * preconditioner[i]);
  let p = [...z];
  let rzOld = dot(r, z);

  let converged = false;
  let iterations = 0;

  for (let k = 0; k < maxIter; k += 1) {
    const ap = applyA(p);
    const alpha = rzOld / Math.max(dot(p, ap), 1e-12);
    x = add(x, scale(p, alpha));
    r = sub(r, scale(ap, alpha));

    const resNorm = Math.sqrt(dot(r, r));
    iterations = k + 1;
    if (resNorm < tol) {
      converged = true;
      break;
    }

    z = r.map((v, i) => v * preconditioner[i]);
    const rzNew = dot(r, z);
    const beta = rzNew / Math.max(rzOld, 1e-12);
    p = add(z, scale(p, beta));
    rzOld = rzNew;
  }

  const residualNorm = Math.sqrt(dot(r, r));
  return {
    signal: x,
    iterations,
    residualNorm,
    converged,
  };
}
