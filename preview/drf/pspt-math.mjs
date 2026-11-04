/** Small float64 linear algebra and the audited Python quadratic-surface model.
 * Coordinates/ranges: m; state=[normal offset m, tangent angle rad, curvature 1/m].
 * No truth geometry or temporal data association is used here.
 */
export const dot = (a, b) => {
  if (a.length !== b.length) throw new RangeError("dot dimensions differ");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};
export const matVec = (a, x) => a.map((row) => dot(row, x));
export const transpose = (a) => a[0].map((_, j) => a.map((row) => row[j]));
export const matMul = (a, b) => { const bt = transpose(b); return a.map((row) => bt.map((col) => dot(row, col))); };
export const cov3 = (s) => [[s[0], s[1]], [s[1], s[2]]];

/** Partial-pivot Gaussian elimination; A[n,n], b[n] or B[n,m], O(n³+n²m).
 * Inputs are copied. No diagonal jitter or changed covariance model is introduced.
 */
export function solve(matrix, rhs) {
  const n = matrix.length, vector = typeof rhs[0] === "number";
  if (!n || rhs.length !== n || matrix.some((row) => row.length !== n)) throw new RangeError("solve dimensions differ");
  const width = vector ? 1 : rhs[0].length;
  const a = matrix.map((row, i) => [...row, ...(vector ? [rhs[i]] : rhs[i])]);
  if (!width || a.some((row) => row.length !== n + width || !row.every(Number.isFinite)))
    throw new RangeError("solve requires finite compatible matrices");
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i][k]) > Math.abs(a[pivot][k])) pivot = i;
    if (a[pivot][k] === 0) throw new RangeError("singular matrix");
    [a[k], a[pivot]] = [a[pivot], a[k]];
    for (let i = k + 1; i < n; i++) {
      const factor = a[i][k] / a[k][k];
      a[i][k] = 0;
      for (let j = k + 1; j < n + width; j++) a[i][j] -= factor * a[k][j];
    }
  }
  const out = Array.from({ length: n }, () => Array(width).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let col = 0; col < width; col++) {
    let value = a[i][n + col];
    for (let j = i + 1; j < n; j++) value -= a[i][j] * out[j][col];
    out[i][col] = value / a[i][i];
    if (!Number.isFinite(out[i][col])) throw new RangeError("nonfinite linear solve");
  }
  return vector ? out.map((row) => row[0]) : out;
}

export const inverse = (a) => solve(a, a.map((_, i) => a.map((__, j) => Number(i === j))));

/** Symmetric [[a,b],[b,c]], ascending eigenvalues and corresponding ROW vectors.
 * PCA needs only this 2x2 covariance, never the full U of an N-by-2 SVD.
 * The axis sign is deterministic; reflection about it is independent of that sign.
 */
export function eigen2(a, b, c) {
  if (![a, b, c].every(Number.isFinite)) throw new RangeError("nonfinite eigensystem");
  const middle = (a + c) / 2, radius = Math.hypot(a - c, 2 * b) / 2;
  const angle = 0.5 * Math.atan2(2 * b, a - c), x = Math.cos(angle), y = Math.sin(angle);
  return { values: [middle - radius, middle + radius], vectors: [[-y, x], [x, y]] };
}

const add = (a, b, scale = 1) => a.map((value, i) => value + scale * b[i]);
const P0_DEFAULT = [[0.25, 0, 0], [0, (Math.PI / 12) ** 2, 0], [0, 0, 0.15 ** 2]];

export class Surfel {
  constructor(c0, phi, nuRef, ell = 1, P0 = P0_DEFAULT) {
    if (c0.length !== 2 || nuRef.length !== 2 || ![...c0, ...nuRef, phi, ell].every(Number.isFinite) || ell <= 0)
      throw new RangeError("invalid quadratic surface");
    if (P0.length !== 3 || P0.some((row) => row.length !== 3 || !row.every(Number.isFinite)))
      throw new RangeError("surface covariance must be a finite 3x3 matrix");
    this.c0 = Array.from(c0);
    const normal = [-Math.sin(phi), Math.cos(phi)];
    this.sg = dot(normal, nuRef) >= 0 ? 1 : -1;
    this.nu0 = normal.map((value) => this.sg * value);
    this.x = [0, phi, 0]; this.x0 = this.x.slice();
    this.P0 = P0.map((row) => Array.from(row)); this.P = this.P0.map((row) => row.slice());
    this.ell = ell;
  }

  get center() { return add(this.c0, this.nu0, this.x[0]); }

  frame() {
    const [, phi, curvature] = this.x;
    return [this.center, [Math.cos(phi), Math.sin(phi)],
      [-this.sg * Math.sin(phi), this.sg * Math.cos(phi)], curvature];
  }

  /** Python-compatible nearest sampled stationary root, with linear interpolation.
   * Returns [rho*,u*,d(rho*)/d(state),e_i,e_j] or null. O(nuGrid), O(1) scratch.
   * This preserves the prototype's single-root approximation; it is not all-root certification.
   */
  predict(pi, pj, { ext = 2, nuGrid = 41 } = {}) {
    if (pi.length !== 2 || pj.length !== 2 || ![...pi, ...pj, ext].every(Number.isFinite)
        || ext <= 0 || !Number.isInteger(nuGrid) || nuGrid < 2) throw new RangeError("invalid surface prediction input");
    const [center, tangent, normal, curvature] = this.frame();
    const lo = -ext * this.ell, spacing = 2 * ext * this.ell / (nuGrid - 1);
    let us = null, previousU, previousResidual;
    for (let i = 0; i < nuGrid; i++) {
      const at = lo + i * spacing, bend = 0.5 * curvature * at * at,
        sx = (center[0] + at * tangent[0]) + bend * normal[0],
        sy = (center[1] + at * tangent[1]) + bend * normal[1],
        dix = sx + -1 * pi[0], diy = sy + -1 * pi[1],
        djx = sx + -1 * pj[0], djy = sy + -1 * pj[1],
        ri = Math.hypot(dix, diy), rj = Math.hypot(djx, djy);
      let residual = NaN;
      if (ri && rj) {
        // Preserve the original dot/add operation order exactly, including its
        // initial +0. Scalar temporaries remove hundreds of tiny arrays per call.
        const slope = curvature * at;
        residual = 0;
        residual += (tangent[0] + slope * normal[0]) * (dix / ri + djx / rj);
        residual += (tangent[1] + slope * normal[1]) * (diy / ri + djy / rj);
      }
      if (i && previousResidual * residual <= 0) {
        const difference = residual - previousResidual;
        const root = previousU - previousResidual * (at - previousU) / (Math.abs(difference) < 1e-15 ? 1e-15 : difference);
        if (us === null || Math.abs(root) < Math.abs(us)) us = root;
      }
      previousU = at; previousResidual = residual;
    }
    if (us === null) return null;
    const s = add(add(center, tangent, us), normal, 0.5 * curvature * us * us);
    if (dot(add(pi, s, -1), normal) <= 0 || dot(add(pj, s, -1), normal) <= 0) return null;
    const di = add(s, pi, -1), dj = add(s, pj, -1), ri = Math.hypot(...di), rj = Math.hypot(...dj);
    if (!ri || !rj) return null;
    const ei = di.map((value) => value / ri), ej = dj.map((value) => value / rj), g = add(ei, ej);
    // Envelope theorem at the stationary point; state dimensions are [m,rad,1/m].
    const derivative = [dot(g, this.nu0), this.sg * dot(g, add(normal.map((value) => us * value), tangent, -0.5 * curvature * us * us)),
      0.5 * us * us * dot(g, normal)];
    return [ri + rj, us, derivative, ei, ej];
  }
}

export function nearestCluster(clusters, rho) {
  let best = -1, distance = Infinity;
  for (let i = 0; i < clusters.length; i++) {
    const current = Math.abs(clusters[i][0] - rho);
    if (current < distance) { best = i; distance = current; }
  }
  return best;
}

export function gate(surface, derivative, poseVariance, rangeVariance, k = 3, minimum = 0.3) {
  return Math.max(minimum, k * Math.sqrt(dot(derivative, matVec(surface.P, derivative)) + poseVariance + rangeVariance));
}

/** Gauss-Newton MAP refinement using only the supplied creation-window configs.
 * Each config: pi/pj[2], Si/Sj[2,2], cl[J,3]=[mean,count,scatter], sr2[m²].
 * O(iters * configs * (nuGrid+clusters) + iters*3³); covariance stays 3x3.
 */
export function refine(surface, snapshots, { iters = 6, ext = 1 } = {}) {
  const priorInverse = inverse(surface.P0), limits = [0.5, Math.PI / 18, 0.1];
  let rows = 0;
  for (let iteration = 0; iteration < iters; iteration++) {
    const H = priorInverse.map((row) => row.slice());
    const b = matVec(priorInverse, add(surface.x, surface.x0, -1)).map((value) => -value);
    rows = 0;
    for (const snapshot of snapshots) for (const config of snapshot) {
      const prediction = surface.predict(config.pi, config.pj, { ext });
      if (prediction === null) continue;
      const [rho, , derivative, ei, ej] = prediction;
      const poseVariance = dot(ei, matVec(config.Si, ei)) + dot(ej, matVec(config.Sj, ej));
      const m = nearestCluster(config.cl, rho);
      if (m < 0 || Math.abs(config.cl[m][0] - rho) > gate(surface, derivative, poseVariance, config.sr2)) continue;
      const variance = config.sr2 / config.cl[m][1] + poseVariance;
      if (!(variance > 0) || !Number.isFinite(variance)) throw new RangeError("invalid refinement variance");
      for (let i = 0; i < 3; i++) {
        b[i] += derivative[i] * (config.cl[m][0] - rho) / variance;
        for (let j = 0; j < 3; j++) H[i][j] += derivative[i] * derivative[j] / variance;
      }
      rows++;
    }
    const change = solve(H, b).map((value, i) => Math.max(-limits[i], Math.min(limits[i], value)));
    surface.x = add(surface.x, change);
    surface.P = inverse(H);
  }
  return rows;
}

export function mirrored(surface, mean, reflection, angle) {
  const out = Object.create(Surfel.prototype);
  out.c0 = add(mean, matVec(reflection, add(surface.c0, mean, -1)));
  out.nu0 = matVec(reflection, surface.nu0); out.sg = -surface.sg; out.ell = surface.ell;
  out.x = [surface.x[0], 2 * angle - surface.x[1], surface.x[2]];
  out.x0 = [surface.x0[0], 2 * angle - surface.x0[1], surface.x0[2]];
  const signs = [1, -1, 1];
  const transformed = (matrix) => matrix.map((row, i) => row.map((value, j) => signs[i] * value * signs[j]));
  out.P = transformed(surface.P); out.P0 = transformed(surface.P0);
  return out;
}
