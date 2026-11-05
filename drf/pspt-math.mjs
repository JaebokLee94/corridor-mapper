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

// Private to each surface: no fitted state or evidence is shared across candidates.
// For an unchanged surface, all vehicle pairs use the same sampled curve and a
// vehicle's same range/unit direction. Keep their float64 operation order, then
// reuse those intermediate values. Large custom grids retain the uncached path.
const predictionCaches = new WeakMap(), MAX_CACHED_GRID = 257, MAX_CACHED_POSITIONS = 24;
function predictionCache(surface, ext, nuGrid) {
  if (nuGrid > MAX_CACHED_GRID || Object.getPrototypeOf(surface) !== Surfel.prototype
      || Object.hasOwn(surface, "frame") || Object.hasOwn(surface, "center")) return null;
  let cache = predictionCaches.get(surface);
  if (cache && cache.ext === ext && cache.nuGrid === nuGrid
      && Object.is(cache.sg, surface.sg) && Object.is(cache.ell, surface.ell)
      && Object.is(cache.c0[0], surface.c0[0]) && Object.is(cache.c0[1], surface.c0[1])
      && Object.is(cache.nu0[0], surface.nu0[0]) && Object.is(cache.nu0[1], surface.nu0[1])
      && Object.is(cache.x[0], surface.x[0]) && Object.is(cache.x[1], surface.x[1]) && Object.is(cache.x[2], surface.x[2])) return cache;
  const frame = surface.frame(), [center, tangent, normal, curvature] = frame,
    lo = -ext * surface.ell, spacing = 2 * ext * surface.ell / (nuGrid - 1), samples = new Float64Array(5 * nuGrid);
  for (let i = 0; i < nuGrid; i++) {
    const at = lo + i * spacing, bend = 0.5 * curvature * at * at, slope = curvature * at, j = 5 * i;
    samples[j] = at;
    samples[j + 1] = (center[0] + at * tangent[0]) + bend * normal[0];
    samples[j + 2] = (center[1] + at * tangent[1]) + bend * normal[1];
    samples[j + 3] = tangent[0] + slope * normal[0];
    samples[j + 4] = tangent[1] + slope * normal[1];
  }
  cache = { ext, nuGrid, sg: surface.sg, ell: surface.ell, c0: surface.c0.slice(), nu0: surface.nu0.slice(),
    x: surface.x.slice(), frame, samples, positions: [] };
  predictionCaches.set(surface, cache);
  return cache;
}

function sampledPosition(cache, point) {
  for (const entry of cache.positions)
    if (Object.is(entry.x, point[0]) && Object.is(entry.y, point[1])) return entry.values;
  const values = new Float64Array(3 * cache.nuGrid);
  for (let i = 0; i < cache.nuGrid; i++) {
    const dx = cache.samples[5 * i + 1] + -1 * point[0], dy = cache.samples[5 * i + 2] + -1 * point[1],
      range = Math.hypot(dx, dy), j = 3 * i;
    values[j] = range; values[j + 1] = dx / range; values[j + 2] = dy / range;
  }
  if (cache.positions.length === MAX_CACHED_POSITIONS) cache.positions.shift();
  cache.positions.push({ x: point[0], y: point[1], values });
  return values;
}

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
   * Returns [rho*,u*,d(rho*)/d(state),e_i,e_j] or null. O(nuGrid) per pair;
   * O(nuGrid * 24) bounded per-surface cache for grids <=257, O(1) scratch otherwise.
   * This preserves the prototype's single-root approximation; it is not all-root certification.
   */
  predict(pi, pj, { ext = 2, nuGrid = 41 } = {}) {
    if (pi.length !== 2 || pj.length !== 2 || ![...pi, ...pj, ext].every(Number.isFinite)
        || ext <= 0 || !Number.isInteger(nuGrid) || nuGrid < 2) throw new RangeError("invalid surface prediction input");
    const cache = predictionCache(this, ext, nuGrid),
      [center, tangent, normal, curvature] = cache ? cache.frame : this.frame(),
      positionsI = cache ? sampledPosition(cache, pi) : null, positionsJ = cache ? sampledPosition(cache, pj) : null;
    const lo = -ext * this.ell, spacing = 2 * ext * this.ell / (nuGrid - 1);
    let us = null, previousU, previousResidual;
    for (let i = 0; i < nuGrid; i++) {
      const at = cache ? cache.samples[5 * i] : lo + i * spacing;
      let residual = NaN;
      if (cache) {
        const j = 3 * i;
        if (positionsI[j] && positionsJ[j]) {
          residual = 0;
          residual += cache.samples[5 * i + 3] * (positionsI[j + 1] + positionsJ[j + 1]);
          residual += cache.samples[5 * i + 4] * (positionsI[j + 2] + positionsJ[j + 2]);
        }
      } else {
        const bend = 0.5 * curvature * at * at,
          sx = (center[0] + at * tangent[0]) + bend * normal[0],
          sy = (center[1] + at * tangent[1]) + bend * normal[1],
          dix = sx + -1 * pi[0], diy = sy + -1 * pi[1],
          djx = sx + -1 * pj[0], djy = sy + -1 * pj[1],
          ri = Math.hypot(dix, diy), rj = Math.hypot(djx, djy);
        if (ri && rj) {
          // Preserve the original dot/add operation order exactly, including its
          // initial +0. Scalar temporaries remove hundreds of tiny arrays per call.
          const slope = curvature * at;
          residual = 0;
          residual += (tangent[0] + slope * normal[0]) * (dix / ri + djx / rj);
          residual += (tangent[1] + slope * normal[1]) * (diy / ri + djy / rj);
        }
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

/** Joint-pose normal equations for one snapshot, without a pair-by-pair inverse.
 * matches[M]: {config:{i,j,Si[2,2],Sj[2,2]}, derivative[3], ei[2], ej[2],
 * rangeVariance>0 [m^2], residual [m]}. Covariances share the wire's PSD contract.
 * Returns H[3,3]=A'R^-1 A and b[3]=A'R^-1 r. R=D+UU', where each U row has
 * at most four nonzero values. Woodbury reduces the solve from M pairs to K<=2V
 * pose-noise dimensions. O(M+K^3), O(K^2+M) memory; no K-time stacking or jitter.
 */
export function sharedPoseNormalEquations(matches) {
  const vehicles = new Map(), sparse = [];
  let dimensions = 0;
  const factorsFor = (id, covariance) => {
    if (vehicles.has(id)) return vehicles.get(id);
    const [[xx, xy], [, yy]] = covariance;
    // Square root also works for zero and rank-one PSD covariance. The clamp
    // removes only Cholesky roundoff; no observation noise is added.
    const a = Math.sqrt(xx), b = a > 0 ? xy / a : 0,
      c = Math.sqrt(Math.max(0, yy - b * b)), factors = [];
    if (a !== 0 || b !== 0) factors.push([dimensions++, a, b]);
    if (c !== 0) factors.push([dimensions++, 0, c]);
    vehicles.set(id, factors);
    return factors;
  };
  for (const match of matches) {
    if (!(match.rangeVariance > 0) || !Number.isFinite(match.rangeVariance))
      throw new RangeError("invalid refinement variance");
    const entries = [];
    for (const [id, direction, covariance] of [[match.config.i, match.ei, match.config.Si], [match.config.j, match.ej, match.config.Sj]])
      for (const [column, x, y] of factorsFor(id, covariance)) entries.push([column, direction[0] * x + direction[1] * y]);
    sparse.push(entries);
  }
  const B = Array.from({ length: dimensions }, (_, i) => Array.from({ length: dimensions }, (_, j) => Number(i === j))),
    W = Array.from({ length: dimensions }, () => [0, 0, 0, 0]),
    N = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (let row = 0; row < matches.length; row++) {
    const match = matches[row], z = [...match.derivative, match.residual], weight = 1 / match.rangeVariance, entries = sparse[row];
    for (const [i, u] of entries) {
      for (let j = 0; j < 4; j++) W[i][j] += weight * u * z[j];
      for (const [j, v] of entries) B[i][j] += weight * u * v;
    }
  }
  const weighted = dimensions ? solve(B, W) : [];
  // Equivalent to Z'D^-1Z-W'B^-1W, but this residual-plus-prior form avoids
  // subtracting almost equal large terms when range noise is much smaller
  // than shared pose noise: N=(Z-UY)'D^-1(Z-UY)+Y'Y, Y=B^-1W.
  for (let row = 0; row < matches.length; row++) {
    const match = matches[row], residual = [...match.derivative, match.residual], weight = 1 / match.rangeVariance;
    for (const [column, value] of sparse[row]) for (let j = 0; j < 4; j++) residual[j] -= value * weighted[column][j];
    for (let i = 0; i < 4; i++) for (let j = i; j < 4; j++) N[i][j] += weight * residual[i] * residual[j];
  }
  for (const row of weighted) for (let i = 0; i < 4; i++) for (let j = i; j < 4; j++) N[i][j] += row[i] * row[j];
  return { H: Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => N[Math.min(i,j)][Math.max(i,j)])),
    b: [N[0][3], N[1][3], N[2][3]] };
}

/** Gauss-Newton MAP refinement using only the supplied creation-window configs.
 * Each config: pi/pj[2], Si/Sj[2,2], cl[J,3]=[mean,count,scatter], sr2[m²].
 * independent-pairs preserves the frozen Python diagonal observation model.
 * shared-pose uses joint vehicle covariance per snapshot. The state stays 3x3;
 * its extra solve has at most 2V pose dimensions, never K times all pairs.
 * O(iters * K * (C*(nuGrid+clusters) + V^3)), O(C+V^2) scratch for shared-pose.
 */
export function refine(surface, snapshots, { iters = 6, ext = 1, refinement = "independent-pairs" } = {}) {
  if (refinement === "shared-pose") return refineSharedPose(surface, snapshots, { iters, ext });
  if (refinement !== "independent-pairs") throw new RangeError("invalid refinement covariance mode");
  // Keep the frozen Python arithmetic for explicit legacy/reference runs.
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

function refineSharedPose(surface, snapshots, { iters, ext }) {
  const priorInverse = inverse(surface.P0), limits = [0.5, Math.PI / 18, 0.1];
  let rows = 0;
  for (let iteration = 0; iteration < iters; iteration++) {
    const H = priorInverse.map((row) => row.slice());
    const b = matVec(priorInverse, add(surface.x, surface.x0, -1)).map((value) => -value);
    rows = 0;
    // Only pairs within the same measured snapshot share pose errors. Never
    // combine K snapshots into a dense (K*C)^2 covariance matrix.
    for (const snapshot of snapshots) {
      const matches = [];
      for (const config of snapshot) {
        const prediction = surface.predict(config.pi, config.pj, { ext });
        if (prediction === null) continue;
        const [rho, , derivative, ei, ej] = prediction;
        const poseVariance = dot(ei, matVec(config.Si, ei)) + dot(ej, matVec(config.Sj, ej));
        const m = nearestCluster(config.cl, rho);
        if (m < 0 || Math.abs(config.cl[m][0] - rho) > gate(surface, derivative, poseVariance, config.sr2)) continue;
        const rangeVariance = config.sr2 / config.cl[m][1];
        if (!(rangeVariance > 0) || !Number.isFinite(rangeVariance)) throw new RangeError("invalid refinement variance");
        matches.push({ config, derivative, ei, ej, rangeVariance, residual: config.cl[m][0] - rho });
      }
      if (!matches.length) continue;
      const normal = sharedPoseNormalEquations(matches);
      for (let i = 0; i < 3; i++) {
        b[i] += normal.b[i];
        for (let j = 0; j < 3; j++) H[i][j] += normal.H[i][j];
      }
      rows += matches.length;
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
