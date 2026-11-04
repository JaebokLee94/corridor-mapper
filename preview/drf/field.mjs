import { makeWire } from "./wire.mjs";

const SQRT_2PI = Math.sqrt(2 * Math.PI), FOCAL_EPS = 1e-9;

/** F16–F22: E uses parameter m=k², not modulus k.
 * AGM correction: E=π/(2 AGM(1,√(1-m))) (1-Σ 2^(n-1)c_n²).
 * Reference: https://dlmf.nist.gov/19.8.E6 . O(log precision), O(1) storage.
 */
export function ellipticE(m) {
  if (!Number.isFinite(m) || m < 0 || m > 1) throw new RangeError("E parameter m must be in [0,1]");
  if (m === 1) return 1;
  let a = 1, b = Math.sqrt(1 - m), correction = m / 2, weight = 1;
  for (let n = 0; n < 32; n++) {
    const c = (a - b) / 2, next = (a + b) / 2;
    correction += weight * c * c;
    b = Math.sqrt(a * b);
    a = next;
    if (Math.abs(c) <= Number.EPSILON * a) return Math.PI * (1 - correction) / (2 * a);
    weight *= 2;
  }
  throw new Error("AGM failed to converge");
}

export function ellipsePerimeter(dHat, rhoHat, method = "exact") {
  if (!Number.isFinite(dHat) || !Number.isFinite(rhoHat) || rhoHat < 0 || dHat <= rhoHat)
    throw new RangeError("ellipse requires dHat > focal separation >= 0");
  const a = dHat / 2, m = (rhoHat / dHat) ** 2;
  if (method === "exact") return 4 * a * ellipticE(m);
  if (method !== "ramanujan") throw new RangeError("unknown ellipse perimeter method");
  const b = a * Math.sqrt(1 - m), h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h)));
}

/** F24–F33: rho=|x-p_i|+|x-p_j|, g=e_i+e_j; positions in m.
 * The focal guard affects division only; it adds no range or model noise.
 */
function geometry(x, y, config, sigmaD) {
  const dix = x - config.pHat_i[0], diy = y - config.pHat_i[1],
    djx = x - config.pHat_j[0], djy = y - config.pHat_j[1],
    ri = Math.hypot(dix, diy), rj = Math.hypot(djx, djy),
    eix = dix / Math.max(ri, FOCAL_EPS), eiy = diy / Math.max(ri, FOCAL_EPS),
    ejx = djx / Math.max(rj, FOCAL_EPS), ejy = djy / Math.max(rj, FOCAL_EPS),
    si = config.Sigma_i, sj = config.Sigma_j,
    variance = sigmaD * sigmaD + si[0] * eix * eix + 2 * si[1] * eix * eiy + si[2] * eiy * eiy
      + sj[0] * ejx * ejx + 2 * sj[1] * ejx * ejy + sj[2] * ejy * ejy;
  if (!(variance > 0) || !Number.isFinite(variance))
    throw new RangeError("residual variance must be positive; all-noise-zero kernels are undefined");
  const sigmaR = Math.sqrt(variance), gNorm = Math.hypot(eix + ejx, eiy + ejy), factor = gNorm / (SQRT_2PI * sigmaR);
  if (!Number.isFinite(ri + rj) || !Number.isFinite(factor)) throw new RangeError("geometry exceeds finite numerical range");
  return { rho: ri + rj, sigmaR, gNorm, factor };
}

/** Scalar fixture/naive check of one path. K may underflow to numerical zero. */
export function pathFieldPoint(point, config, path, { perimeter = "exact" } = {}) {
  const checked = makeWire({ t: 1, configs: [{ i: config.i, j: config.j, pHat_i: config.pHat_i,
    pHat_j: config.pHat_j, Sigma_i: config.Sigma_i, Sigma_j: config.Sigma_j, paths: [path] }] }).configs[0],
    focal = Math.hypot(checked.pHat_j[0] - checked.pHat_i[0], checked.pHat_j[1] - checked.pHat_i[1]);
  if (path.dHat <= focal) return { admitted: false, P: 0, alpha: 0, K: 0, u: 0 };
  if (!(Array.isArray(point) || ArrayBuffer.isView(point)) || point.length !== 2 || !Array.from(point).every(Number.isFinite))
    throw new RangeError("point must be a finite coordinate pair");
  const g = geometry(point[0], point[1], checked, path.sigmaD),
    P = ellipsePerimeter(path.dHat, focal, perimeter), r = g.rho - path.dHat,
    K = Math.exp(-0.5 * (r / g.sigmaR) ** 2), alpha = g.factor / P;
  return { admitted: true, ...g, P, r, K, alpha, u: alpha * K };
}

/** Cell centers, index=iy*nx+ix, y ascending. O(nx+ny) coordinate storage. */
export function createGrid(nx = 150, ny = 150, domain = [0, 60, 0, 30]) {
  if (!Number.isSafeInteger(nx) || !Number.isSafeInteger(ny) || nx < 1 || ny < 1 || !Number.isSafeInteger(nx * ny))
    throw new RangeError("grid dimensions must be positive safe integers");
  if (!(Array.isArray(domain) || ArrayBuffer.isView(domain)) || domain.length !== 4 || !Array.from(domain).every(Number.isFinite))
    throw new RangeError("domain must contain four finite bounds");
  const [xmin, xmax, ymin, ymax] = domain;
  if (!(xmax > xmin && ymax > ymin)) throw new RangeError("grid bounds must increase");
  const dx = (xmax - xmin) / nx, dy = (ymax - ymin) / ny;
  return { nx, ny, domain: Array.from(domain), xmin, xmax, ymin, ymax, dx, dy,
    x: Float64Array.from({ length: nx }, (_, ix) => xmin + (ix + 0.5) * dx),
    y: Float64Array.from({ length: ny }, (_, iy) => ymin + (iy + 0.5) * dy) };
}

function lowerBound(paths, value) {
  let lo = 0, hi = paths.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (paths[mid].dHat < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** C configurations, G grid cells, P paths/config, B band candidate visits:
 * O(C[P log P+G log P]+B) time, O(G+P) scratch; D/A accumulate float64.
 * F41 A=f(x)Σ(1/P_q); sigmaD must be equal within each configuration.
 */
export function createField(grid, { band = 4, perimeter = "exact" } = {}) {
  if (![3, 4, 5, "full"].includes(band) || !["exact", "ramanujan"].includes(perimeter))
    throw new RangeError("numerical settings require band 3/4/5/full and exact/ramanujan perimeter");
  const { nx, ny, x, y } = grid, count = nx * ny;
  if (!Number.isSafeInteger(nx) || !Number.isSafeInteger(ny) || nx < 1 || ny < 1
      || x?.length !== nx || y?.length !== ny || !Array.from(x).every(Number.isFinite) || !Array.from(y).every(Number.isFinite))
    throw new RangeError("invalid grid coordinate arrays");
  const D = new Float64Array(count), A = new Float64Array(count),
    deltaD = new Float64Array(count), deltaA = new Float64Array(count);
  let t = 0, Q = 0, admitted = 0, rejected = 0, epsilonA = 0;
  function readout() {
    let maxA = 0;
    for (const a of A) maxA = Math.max(maxA, a);
    epsilonA = 1e-12 * maxA;
    const Dbar = new Float32Array(count), betaHat = new Float32Array(count);
    for (let g = 0; g < count; g++) {
      Dbar[g] = D[g] / Math.max(Q, 1);
      betaHat[g] = A[g] + epsilonA > 0 ? D[g] / (A[g] + epsilonA) : 0;
    }
    return { t, Dbar, betaHat, Q, admitted, rejected, epsilonA };
  }
  return {
    grid, D, A,
    get Q() { return Q; },
    get t() { return t; },
    get admitted() { return admitted; },
    get rejected() { return rejected; },
    readout,
    inspect(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new RangeError("grid index out of bounds");
      return { t, D: D[index], A: A[index], Q, Dbar: D[index] / Math.max(Q, 1),
        betaHat: A[index] + epsilonA > 0 ? D[index] / (A[index] + epsilonA) : 0 };
    },
    step(snapshot) {
      const started = performance.now(), wire = makeWire(snapshot);
      if (wire.t !== t + 1) throw new RangeError("snapshots must be processed once in causal t=1,2,... order");
      deltaD.fill(0); deltaA.fill(0);
      let nAdmitted = 0, nRejected = 0;
      for (const config of wire.configs) {
        if (!config.paths.length) continue;
        const sigmaD = config.paths[0].sigmaD;
        if (config.paths.some((p) => p.sigmaD !== sigmaD)) throw new RangeError("configuration paths must have identical sigmaD for factorization");
        const focal = Math.hypot(config.pHat_j[0] - config.pHat_i[0], config.pHat_j[1] - config.pHat_i[1]),
          paths = config.paths.filter((p) => p.dHat > focal).map((p) => ({ dHat: p.dHat,
            inverseP: 1 / ellipsePerimeter(p.dHat, focal, perimeter) })).sort((a, b) => a.dHat - b.dHat);
        nAdmitted += paths.length;
        nRejected += config.paths.length - paths.length;
        if (!paths.length) continue;
        const inversePSum = paths.reduce((sum, p) => sum + p.inverseP, 0);
        for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
          const g = iy * nx + ix, geo = geometry(x[ix], y[iy], config, sigmaD);
          deltaA[g] += geo.factor * inversePSum;
          const radius = band === "full" ? Infinity : band * geo.sigmaR,
            lo = geo.rho - radius, hi = geo.rho + radius;
          let sum = 0;
          for (let q = band === "full" ? 0 : lowerBound(paths, lo); q < paths.length && paths[q].dHat <= hi; q++) {
            const z = (geo.rho - paths[q].dHat) / geo.sigmaR;
            sum += paths[q].inverseP * Math.exp(-0.5 * z * z);
          }
          deltaD[g] += geo.factor * sum;
        }
      }
      // Commit only after every configuration succeeds: malformed input leaves the prior frame intact.
      for (let g = 0; g < count; g++) {
        const d = D[g] + deltaD[g], a = A[g] + deltaA[g];
        if (!Number.isFinite(d) || !Number.isFinite(a) || d < 0 || a < 0 || d > a * (1 + 1e-12))
          throw new Error("nonnegative field or beta bound invariant violated");
      }
      for (let g = 0; g < count; g++) { D[g] += deltaD[g]; A[g] += deltaA[g]; }
      t = wire.t; Q += nAdmitted; admitted += nAdmitted; rejected += nRejected;
      const frame = readout();
      return { ...frame, ms: performance.now() - started };
    },
  };
}
