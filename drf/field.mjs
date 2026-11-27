import { makeWire } from "./wire.mjs";
import { validateFieldUpdateCache, findFieldIncrement, saveFieldIncrement } from "./field-reuse.mjs";

const SQRT_2PI = Math.sqrt(2 * Math.PI), FOCAL_EPS = 1e-9;

// V8's two-input Math.hypot divides both magnitudes by the larger one. Its
// normalized square is exactly 1, so only the smaller magnitude needs division.
function scaledHypot2(x, y) {
  const a = Math.abs(x), b = Math.abs(y), scale = Math.max(a, b);
  if (scale === 0) return 0;
  if (!Number.isFinite(scale)) return Math.hypot(x, y);
  const ratio = Math.min(a, b) / scale;
  return scale * Math.sqrt(1 + ratio * ratio);
}
const scaledV8Hypot = (globalThis.process?.versions?.v8 || /\b(?:Chrome|Chromium)\/\d+/.test(globalThis.navigator?.userAgent ?? ''))
  && Math.hypot(.1, .4) === scaledHypot2(.1, .4);

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

// A vehicle appears in multiple measured pairs. Reuse only the grid distances
// and unit directions; covariance, range noise and accumulation stay pair specific.
let spareFocalBuffers = [];
function focalGrid(id, pose, slots, maxSlots, x, y, buffers) {
  let slot = slots.get(id);
  if (slot && Object.is(slot.px, pose[0]) && Object.is(slot.py, pose[1])) return slot.data;
  if (!slot) {
    if (slots.size >= maxSlots) return null;
    const length = 3 * x.length * y.length, spare = buffers?.pop();
    slot = {data: spare?.length === length ? spare : new Float64Array(length)};
    slots.set(id, slot);
  }
  slot.px = pose[0]; slot.py = pose[1];
  let j = 0;
  for (let iy = 0; iy < y.length; iy++) {
    const dy = y[iy] - pose[1];
    for (let ix = 0; ix < x.length; ix++) {
      const dx = x[ix] - pose[0], radius = Math.hypot(dx, dy), denom = Math.max(radius, FOCAL_EPS);
      slot.data[j++] = radius; slot.data[j++] = dx / denom; slot.data[j++] = dy / denom;
    }
  }
  return slot.data;
}

// For zero position covariance, sigmaR is constant at all grid points.
function accumulateKnownPoses(fi, fj, paths, sigmaD, band, inversePSum, deltaD, deltaA, hypot) {
  const variance = sigmaD * sigmaD;
  if (!(variance > 0) || !Number.isFinite(variance))
    throw new RangeError("residual variance must be positive; all-noise-zero kernels are undefined");
  const sd = Math.sqrt(variance), denom = SQRT_2PI * sd,
    radius = band === "full" ? Infinity : band * sd;
  const minPath = paths[0].dHat, maxPath = paths[paths.length - 1].dHat;
  for (let g = 0, j = 0; g < deltaA.length; g++, j += 3) {
    const rho = fi[j] + fj[j], factor = hypot(fi[j + 1] + fj[j + 1], fi[j + 2] + fj[j + 2]) / denom;
    if (!Number.isFinite(rho) || !Number.isFinite(factor)) throw new RangeError("geometry exceeds finite numerical range");
    deltaA[g] += factor * inversePSum;
    const lo = rho - radius, hi = rho + radius;
    if (hi < minPath || lo > maxPath) continue;
    let sum = 0;
    for (let q = lowerBound(paths, lo); q < paths.length && paths[q].dHat <= hi; q++) {
      const z = (rho - paths[q].dHat) / sd;
      sum += paths[q].inverseP * Math.exp(-0.5 * z * z);
    }
    deltaD[g] += factor * sum;
  }
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

/** WM-P needs the unnormalized density D to locate ridges. Only cells inside
 * the largest admitted ellipse plus four residual SDs can contribute to D.
 * Input is the measured wire, output is cumulative density on the cell centers.
 * O(C*G*P) worst case, O(G) field plus at most 16 MiB of shared focal geometry.
 */
export function createRidgeDensityField(grid) {
  const {nx, ny, x, y, dx, dy} = grid, D = new Float64Array(nx * ny);
  const delta = new Float64Array(D.length), slots = new Map();
  const maxSlots = Math.floor(16 * 1024 * 1024 / (D.length * 3 * 8));
  let t = 0, Q = 0;
  return {D, get Q() { return Q; }, step(snapshot) {
    const wire = makeWire(snapshot);
    if (wire.t !== t + 1) throw new RangeError("snapshots must be processed once in causal t=1,2,... order");
    delta.fill(0);
    let admitted = 0;
    for (const config of wire.configs) {
      if (!config.paths.length) continue;
      const sd = config.paths[0].sigmaD;
      if (!(sd*sd > 0) || !Number.isFinite(sd*sd)) throw new RangeError("ridge density requires finite positive range variance");
      if (config.paths.some(p => p.sigmaD !== sd)) throw new RangeError("configuration paths must have identical sigmaD");
      const [ax, ay] = config.pHat_i, [bx, by] = config.pHat_j, focal = Math.hypot(bx - ax, by - ay);
      const paths = config.paths.filter(p => p.dHat > focal).map(p => ({
        dHat: p.dHat, inverseP: 1 / ellipsePerimeter(p.dHat, focal)
      })).sort((a,b) => a.dHat - b.dHat);
      if (!paths.length) continue;
      admitted += paths.length;
      const si = config.Sigma_i, sj = config.Sigma_j, fixed = si.every(v => v === 0) && sj.every(v => v === 0);
      const variance = sd * sd, fixedSD = Math.sqrt(variance);
      const minPath = paths[0].dHat, maxPath = paths[paths.length-1].dHat;
      // The trace of a PSD position covariance bounds its projection on every unit direction.
      const maxRange = maxPath + 4 * Math.sqrt(variance + si[0] + si[2] + sj[0] + sj[2]);
      // Project the enclosing ellipse on each axis. Include one extra cell for roundoff.
      const halfWidth = d => .5 * Math.sqrt(Math.max(0, (maxRange - Math.abs(d)) * (maxRange + Math.abs(d))));
      const hx = halfWidth(by - ay), hy = halfWidth(bx - ax), mx = .5*ax + .5*bx, my = .5*ay + .5*by;
      const ix0 = Math.max(0, Math.floor((mx - hx - x[0]) / dx) - 1), ix1 = Math.min(nx-1, Math.ceil((mx + hx - x[0]) / dx) + 1);
      const iy0 = Math.max(0, Math.floor((my - hy - y[0]) / dy) - 1), iy1 = Math.min(ny-1, Math.ceil((my + hy - y[0]) / dy) + 1);
      const fi = focalGrid(config.i, config.pHat_i, slots, maxSlots, x, y);
      const fj = focalGrid(config.j, config.pHat_j, slots, maxSlots, x, y);
      for (let iy=iy0; iy<=iy1; iy++) for (let ix=ix0; ix<=ix1; ix++) {
        const cell = iy*nx + ix, j = 3*cell;
        let rho, sigmaR, factor;
        if (fi && fj) {
          rho = fi[j] + fj[j];
          const u=fi[j+1], v=fi[j+2], w=fj[j+1], z=fj[j+2];
          sigmaR = fixed ? fixedSD : Math.sqrt(variance + si[0]*u*u + 2*si[1]*u*v + si[2]*v*v + sj[0]*w*w + 2*sj[1]*w*z + sj[2]*z*z);
          if (!(sigmaR > 0) || !Number.isFinite(sigmaR)) throw new RangeError("invalid residual variance");
          if (rho+4*sigmaR < minPath || rho-4*sigmaR > maxPath) continue;
          factor = Math.hypot(u+w,v+z) / (SQRT_2PI * sigmaR);
        } else {
          ({rho, sigmaR, factor} = geometry(x[ix], y[iy], config, sd));
        }
        const lo=rho-4*sigmaR, hi=rho+4*sigmaR;
        let sum=0;
        for (let p=lowerBound(paths,lo); p<paths.length && paths[p].dHat<=hi; p++) {
          const z=(rho-paths[p].dHat)/sigmaR;
          sum += paths[p].inverseP * Math.exp(-.5*z*z);
        }
        delta[cell] += factor * sum;
      }
    }
    for (let k=0; k<D.length; k++) if (!Number.isFinite(D[k]+delta[k])) throw new RangeError("nonfinite ridge density");
    for (let k=0; k<D.length; k++) D[k] += delta[k];
    t=wire.t; Q+=admitted;
  }};
}

/** C configurations, G grid cells, P paths/config, B band candidate visits:
 * O(C[P log P+G log P]+B) time, O(G+P) scratch plus up to 16 MiB for focal grids; D/A accumulate float64.
 * F41 A=f(x)Σ(1/P_q); sigmaD must be equal within each configuration.
 */
export function createField(grid, { band = 4, perimeter = "exact", updateCache = null, viewBounds } = {}) {
  validateFieldUpdateCache(updateCache);
  if (![3, 4, 5, "full"].includes(band) || !["exact", "ramanujan"].includes(perimeter))
    throw new RangeError("numerical settings require band 3/4/5/full and exact/ramanujan perimeter");
  const { nx, ny, x, y } = grid, count = nx * ny;
  const viewport = viewBounds !== undefined, hypot = viewport && scaledV8Hypot ? scaledHypot2 : Math.hypot;
  // Match the arrays captured by this field, even if the caller replaces grid.x/y.
  const calculationGrid = { nx, ny, x, y };
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
      const reused = findFieldIncrement(updateCache, wire, calculationGrid, band, perimeter);
      if (reused) {
        deltaD.set(reused.deltaD); deltaA.set(reused.deltaA);
        nAdmitted = reused.admitted; nRejected = reused.rejected;
      }
      // Grid coordinates may be edited by the caller between steps.
      const slots = new Map(), maxSlots = Math.floor((16 * 1024 * 1024) / (3 * 8 * count));
      const buffers = viewport ? spareFocalBuffers : undefined;
      for (const config of reused ? [] : wire.configs) {
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
        if (wire.configs.length >= 3 && maxSlots >= 2 &&
            config.Sigma_i.every(value => value === 0) && config.Sigma_j.every(value => value === 0)) {
          const fi = focalGrid(config.i, config.pHat_i, slots, maxSlots, x, y, buffers),
            fj = focalGrid(config.j, config.pHat_j, slots, maxSlots, x, y, buffers);
          if (fi && fj) {
            accumulateKnownPoses(fi, fj, paths, sigmaD, band, inversePSum, deltaD, deltaA, hypot);
            continue;
          }
        }
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
      // Keep at most one step's (16 MiB) storage per worker. Geometry is rebuilt
      // after checkout, even if vehicle IDs and poses repeat on an edited grid.
      if (viewport && slots.size) spareFocalBuffers = Array.from(slots.values(), slot => slot.data);
      // Commit only after every configuration succeeds: malformed input leaves the prior frame intact.
      for (let g = 0; g < count; g++) {
        const d = D[g] + deltaD[g], a = A[g] + deltaA[g];
        if (!Number.isFinite(d) || !Number.isFinite(a) || d < 0 || a < 0 || d > a * (1 + 1e-12))
          throw new Error("nonnegative field or beta bound invariant violated");
      }
      for (let g = 0; g < count; g++) { D[g] += deltaD[g]; A[g] += deltaA[g]; }
      t = wire.t; Q += nAdmitted; admitted += nAdmitted; rejected += nRejected;
      if (!reused) saveFieldIncrement(updateCache, wire, calculationGrid, band, perimeter, deltaD, deltaA, nAdmitted, nRejected);
      const frame = readout();
      return { ...frame, ms: performance.now() - started };
    },
  };
}
