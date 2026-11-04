import { createRng } from './rng.mjs';
import { realRoots } from './poly.mjs';

/** Not-a-knot cubic spline. Input x,y: n scalars; output: n-1 local
 * [c3,c2,c1,c0] spans. O(n^3), n=7 in the reference scene. */
export function notAKnot(x, y) {
  const n = x.length;
  if (n < 4 || y.length !== n || !x.every(Number.isFinite) || !y.every(Number.isFinite)) throw new TypeError('Spline requires matching finite arrays with >= 4 knots');
  const h = x.slice(1).map((value, i) => value - x[i]);
  if (h.some(value => value <= 0)) throw new RangeError('Spline knots must increase');
  const a = Array.from({ length: n }, () => Array(n + 1).fill(0));
  a[0][0] = -h[1]; a[0][1] = h[0] + h[1]; a[0][2] = -h[0];
  for (let i = 1; i < n - 1; i++) {
    a[i][i - 1] = h[i - 1]; a[i][i] = 2 * (h[i - 1] + h[i]); a[i][i + 1] = h[i];
    a[i][n] = 6 * ((y[i + 1] - y[i]) / h[i] - (y[i] - y[i - 1]) / h[i - 1]);
  }
  a[n - 1][n - 3] = -h[n - 2]; a[n - 1][n - 2] = h[n - 3] + h[n - 2]; a[n - 1][n - 1] = -h[n - 3];
  // ponytail: dense solve for seven knots; use a banded solver if knot count grows.
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i][k]) > Math.abs(a[pivot][k])) pivot = i;
    [a[k], a[pivot]] = [a[pivot], a[k]];
    const diagonal = a[k][k];
    for (let j = k; j <= n; j++) a[k][j] /= diagonal;
    for (let i = k + 1; i < n; i++) {
      const factor = a[i][k];
      for (let j = k; j <= n; j++) a[i][j] -= factor * a[k][j];
    }
  }
  const second = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) second[i] = a[i][n] - a[i].slice(i + 1, n).reduce((sum, value, j) => sum + value * second[i + j + 1], 0);
  return h.map((width, i) => [(second[i + 1] - second[i]) / (6 * width), second[i] / 2,
    (y[i + 1] - y[i]) / width - width * (2 * second[i] + second[i + 1]) / 6, y[i]]);
}
export function makeSpan(C, span, wall = 0, last = false) {
  const controls = [C[0], C[0].map((v, d) => v + C[1][d] / 3),
    C[0].map((v, d) => v + 2 * C[1][d] / 3 + C[2][d] / 3), C[0].map((v, d) => v + C[1][d] + C[2][d] + C[3][d])];
  return { C, span, wall, last, aabb: [Math.min(...controls.map(p => p[0])), Math.min(...controls.map(p => p[1])), Math.max(...controls.map(p => p[0])), Math.max(...controls.map(p => p[1]))] };
}
export function graphSpans(x, y, wall = 0, firstSpan = 1) {
  return notAKnot(x, y).map(([c3, c2, c1, c0], i) => {
    const h = x[i + 1] - x[i];
    return { ...makeSpan([[x[i], c0], [h, c1 * h], [0, c2 * h * h], [0, c3 * h ** 3]], firstSpan + i, wall, i === x.length - 2), h };
  });
}
export function bsplineSpans(points, { closed = true, wall = 0, firstSpan = 1 } = {}) {
  const M = [[1, 4, 1, 0], [-3, 0, 3, 0], [3, -6, 3, 0], [-1, 3, -3, 1]], count = closed ? points.length : points.length - 3;
  return Array.from({ length: count }, (_, k) => {
    const C = M.map(row => [0, 1].map(d => row.reduce((sum, value, j) => sum + value * points[(k + j) % points.length][d] / 6, 0)));
    return makeSpan(C, firstSpan + k, wall, !closed && k === count - 1);
  });
}
export function createWalls({ scene = 'reference', seed = 1 } = {}) {
  const x = [0, 10, 20, 30, 40, 50, 60], lower = [8, 6, 9, 7.5, 10, 8, 7], upper = [22, 24, 21, 23.5, 20, 22.5, 23];
  if (scene === 'random') {
    const rng = createRng(seed, 'wall');
    // Exploratory scene only: bounded knot perturbations, not an Octave fixture.
    for (let i = 0; i < x.length; i++) { lower[i] += rng.uniform() - 0.5; upper[i] += rng.uniform() - 0.5; }
  } else if (scene !== 'reference') throw new RangeError('Unknown corridor scene');
  return [...graphSpans(x, lower, 0, 1), ...graphSpans(x, upper, 1, 7)];
}

/** Truth-only, data-only two-layer wall model. The legacy createWalls fixture
 * remains separate. Coefficients are iid N(0,2*sigma^2), not interpolated data.
 * N3 is the centered cardinal cubic basis with support [-2,2]. Its knot value
 * is (c[j-1]+4*c[j]+c[j+1])/6. Let S = L/deltaM + L/deltaD.
 * Storage is O(S); work is O(S log S) with independent-wall gap extrema,
 * or O(S) for the archived shared-centre draw.
 * independent=true draws separate large-scale components for both walls.
 * A constant symmetric translation enforces minWidth without changing either
 * curve's derivatives. The route midpoint is derived after wall generation.
 * The default shared model remains available for archived numerical fixtures.
 * This function draws one attempt; the caller owns domain rejection. */
export function createTwoLayerWallModel({ seed = 1, attempt = 0, L = 60, W = 12,
  baseline = 15, sigmaM = 6, deltaM = 20, sigmaDGeometry = 0.33, deltaD = 4, wallSide = 'both',
  independent = false, minWidth = 6 } = {}) {
  if (!['both', 'upper', 'lower'].includes(wallSide)) throw new RangeError('Wall side must be both, upper or lower');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Seed must be a uint32');
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError('Wall attempt must be a nonnegative integer');
  if (![L, W, deltaM, deltaD, minWidth].every(value => Number.isFinite(value) && value > 0)
    || ![sigmaM, sigmaDGeometry].every(value => Number.isFinite(value) && value >= 0)
    || !Number.isFinite(baseline)) throw new RangeError('Wall lengths, amplitudes and baseline must be finite and valid');
  const component = (spacing, sigma, ...address) => {
    const rng = createRng(seed, 'wall', ...address, ...(attempt ? [attempt] : []));
    const origin = rng.uniform() * spacing;
    // x=0 starts in interval j=-1; its four active coefficients are j=-2..1.
    // Padding supplies all four active basis functions throughout [0,L].
    const coefficients = Array.from({ length: Math.ceil(L / spacing) + 4 }, () => Math.SQRT2 * sigma * rng.normal());
    return { spacing, origin, start: -2, coefficients };
  };
  const model = { kind: 'two-layer-uniform-cubic', seed, attempt, L, W, baseline, wallSide,
    ...(independent && wallSide === 'both'
      ? { m: [0, 1].map(wall => component(deltaM, sigmaM, 'm', wall)), separation: 0 }
      : { mu: component(deltaM, sigmaM, 'mu') }),
    d: [0, 1].map(wall => wallSide === 'both' || wall === (wallSide === 'lower' ? 0 : 1)
      ? component(deltaD, sigmaDGeometry, 'd', wall) : null) };
  if (model.m) {
    model.kind = 'independent-wall-uniform-cubic';
    model.minWidthRequired = minWidth;
    const deficit = minWidth - twoLayerWallBounds(model).minWidth;
    // Metres: a tiny numerical margin keeps the exact-extrema check above the
    // lower bound after Float64 subtraction. No pointwise clipping of walls.
    model.separation = deficit >= 0 ? deficit + 1e-9 : 0;
  }
  return model;
}

/** Scalar value and x derivatives (m, dimensionless, 1/m, 1/m^2), O(1).
 * The third derivative at a knot is right-sided; value/first/second are C2. */
export function evaluateUniformCubic(component, x) {
  if (!Number.isFinite(x)) throw new RangeError('Spline coordinate must be finite');
  const { spacing, origin, start, coefficients } = component;
  let coordinate = (x - origin) / spacing;
  const knot = Math.round(coordinate);
  // Arithmetic reconstruction of origin+j*spacing can land one ULP left.
  if (Math.abs(coordinate - knot) <= 4 * Number.EPSILON * Math.max(1, Math.abs(coordinate))) coordinate = knot;
  const j = Math.floor(coordinate), u = coordinate - j, index = j - 1 - start;
  if (index < 0 || index + 3 >= coefficients.length) throw new RangeError('Spline coordinate is outside full coefficient support');
  const [a, b, c, d] = coefficients.slice(index, index + 4);
  const C0 = (a + 4 * b + c) / 6, C1 = (c - a) / 2,
    C2 = (a - 2 * b + c) / 2, C3 = (-a + 3 * b - 3 * c + d) / 6;
  return { value: ((C3 * u + C2) * u + C1) * u + C0,
    first: ((3 * C3 * u + 2 * C2) * u + C1) / spacing,
    second: (6 * C3 * u + 2 * C2) / spacing ** 2,
    third: 6 * C3 / spacing ** 3 };
}

function checkWallX(model, x) {
  if (!Number.isFinite(x) || x < 0 || x > model.L) throw new RangeError('Wall coordinate must lie in [0,L]');
}
export function evaluateCentre(model, x) {
  checkWallX(model, x);
  if (model.m) {
    const lower = evaluateWall(model, x, 0), upper = evaluateWall(model, x, 1);
    return Object.fromEntries(['value', 'first', 'second', 'third'].map(key => [key, (lower[key] + upper[key]) / 2]));
  }
  const value = evaluateUniformCubic(model.mu, x);
  return { ...value, value: model.baseline + value.value };
}
export function evaluateWall(model, x, wall) {
  if (wall !== 0 && wall !== 1) throw new RangeError('Wall ID must be 0 (lower) or 1 (upper)');
  if (!model.d[wall]) throw new RangeError('Requested wall is absent from this model');
  checkWallX(model, x);
  const primary = model.m ? evaluateUniformCubic(model.m[wall], x) : evaluateCentre(model, x),
    d = evaluateUniformCubic(model.d[wall], x), side = wall === 1 ? 1 : -1;
  return { value: (model.m ? model.baseline : 0) + primary.value + side * (model.W / 2 + (model.separation ?? 0) / 2 + d.value),
    first: primary.first + side * d.first, second: primary.second + side * d.second,
    third: primary.third + side * d.third };
}

function componentKnots(component, L) {
  const out = [];
  for (let j = Math.ceil(-component.origin / component.spacing); ; j++) {
    const x = component.origin + j * component.spacing;
    if (x >= L) break;
    if (x > 0) out.push(x);
  }
  return out;
}
const unionKnots = (L, components) => [...new Set([0, L, ...components.flatMap(component => componentKnots(component, L))])].sort((a, b) => a - b);
function scalarPower(value, h) {
  return [value.value, value.first * h, value.second * h * h / 2, value.third * h ** 3 / 6];
}

/** Sum the independent knot grids as exact local cubic power spans, O(S log S)
 * for sorting the union, O(S) storage (S is the total knot count).
 * makeSpan supplies the Bezier-control convex-hull AABB for visibility.
 * Shared endpoints belong to the next span; only each wall's last has u=1. */
export function twoLayerWallSpans(model) {
  const spans = [];
  for (let wall = 0; wall < 2; wall++) {
    if (!model.d[wall]) continue;
    const knots = unionKnots(model.L, [model.m?.[wall] ?? model.mu, model.d[wall]]);
    for (let k = 0; k < knots.length - 1; k++) {
      const x = knots[k], h = knots[k + 1] - x, C = scalarPower(evaluateWall(model, x, wall), h);
      spans.push({ ...makeSpan([[x, C[0]], [h, C[1]], [0, C[2]], [0, C[3]]], spans.length + 1, wall, k === knots.length - 2), h });
    }
  }
  return spans;
}

/** Exact cubic extrema up to Float64/root-solver tolerance; not sampled bounds.
 * No validity policy is imposed. minWidth tests passage opening; bounds tests
 * a caller-selected world coordinate system domain. O(S log S) knot unions
 * plus O(S) constant-degree root searches; O(S) storage. */
export function twoLayerWallBounds(model) {
  const extrema = C => [0, 1, ...realRoots([C[1], 2 * C[2], 3 * C[3]])]
    .map(u => ((C[3] * u + C[2]) * u + C[1]) * u + C[0]);
  const spans = twoLayerWallSpans(model), wallRanges = [0, 1].map(wall => {
    const values = spans.filter(span => span.wall === wall).flatMap(span => extrema(span.C.map(row => row[1])));
    return values.length ? [Math.min(...values), Math.max(...values)] : null;
  });
  if (wallRanges.some(range => range === null)) {
    const range = wallRanges.find(range => range !== null), knots = unionKnots(model.L, [model.mu]), centres = [];
    for (let k = 0; k < knots.length - 1; k++)
      centres.push(...extrema(scalarPower(evaluateCentre(model, knots[k]), knots[k + 1] - knots[k])));
    return { xmin: 0, xmax: model.L, ymin: range[0], ymax: range[1], wallRanges, minWidth: null, maxWidth: null,
      centreRange: [Math.min(...centres), Math.max(...centres)] };
  }
  const knots = unionKnots(model.L, [...(model.m ?? []), ...model.d]), widths = [];
  for (let k = 0; k < knots.length - 1; k++) {
    const x = knots[k], h = knots[k + 1] - x;
    // Independent walls: include both large-scale knot grids in the exact gap.
    // Preserve the archived shared-model arithmetic for fixture reproducibility.
    const lower = model.m ? evaluateWall(model, x, 0) : evaluateUniformCubic(model.d[0], x),
      upper = model.m ? evaluateWall(model, x, 1) : evaluateUniformCubic(model.d[1], x);
    const sum = Object.fromEntries(['value', 'first', 'second', 'third'].map(key => [key, model.m ? upper[key] - lower[key] : lower[key] + upper[key]]));
    if (!model.m) sum.value += model.W;
    widths.push(...extrema(scalarPower(sum, h)));
  }
  return { xmin: 0, xmax: model.L, ymin: Math.min(...wallRanges.map(range => range[0])), ymax: Math.max(...wallRanges.map(range => range[1])),
    wallRanges, minWidth: Math.min(...widths), maxWidth: Math.max(...widths) };
}
export function evaluate(span, u) {
  const { C } = span;
  return {
    s: [0, 1].map(d => ((C[3][d] * u + C[2][d]) * u + C[1][d]) * u + C[0][d]),
    t: [0, 1].map(d => (3 * C[3][d] * u + 2 * C[2][d]) * u + C[1][d]),
    dd: [0, 1].map(d => 6 * C[3][d] * u + 2 * C[2][d]),
  };
}
const cache = new WeakMap();
/** Geometry-only quadrature cells, reused across configurations. */
export function wallCells(spans, step, partition = 'arc') {
  if (!(Number.isFinite(step) && step > 0)) throw new RangeError('Cell step must be positive');
  let stored = cache.get(spans);
  if (!stored) { stored = new Map(); cache.set(spans, stored); }
  const key = `${partition}:${step}`;
  if (stored.has(key)) return stored.get(key);
  const cells = [];
  for (const span of spans) {
    let boundaries;
    if (partition === 'x') {
      if (!span.h) throw new RangeError('x partition requires graph spans');
      const n = Math.ceil(span.h / step);
      boundaries = Array.from({ length: n + 1 }, (_, i) => Math.min(1, i * step / span.h));
    } else if (partition === 'arc') {
      const lengthBound = span.C.slice(1).reduce((sum, row, i) => sum + (i + 1) * Math.hypot(...row), 0);
      const n = Math.max(32, Math.ceil(lengthBound / step)), arc = new Float64Array(n + 1);
      const speed = u => Math.hypot(...evaluate(span, u).t);
      for (let i = 0; i < n; i++) arc[i + 1] = arc[i] + (speed(i / n) + 4 * speed((i + 0.5) / n) + speed((i + 1) / n)) / (6 * n);
      const count = Math.ceil(arc[n] / step);
      let index = 0;
      boundaries = Array.from({ length: count + 1 }, (_, i) => {
        const target = i * arc[n] / count;
        while (index < n - 1 && arc[index + 1] < target) index++;
        return (index + (target - arc[index]) / (arc[index + 1] - arc[index])) / n;
      });
      boundaries[0] = 0; boundaries[count] = 1;
    } else throw new RangeError('Unknown cell partition');
    for (let i = 0; i < boundaries.length - 1; i++) {
      const du = boundaries[i + 1] - boundaries[i], u = (boundaries[i + 1] + boundaries[i]) / 2, value = evaluate(span, u);
      cells.push({ ...value, u, du, ds: Math.hypot(...value.t) * du, span: span.span, wall: span.wall });
    }
  }
  stored.set(key, cells);
  return cells;
}
export function sampleWalls(spans, step = 0.1) {
  const walls = Array.from({ length: Math.max(1, ...spans.map(s => s.wall)) + 1 }, () => []);
  for (const cell of wallCells(spans, step)) walls[cell.wall].push(cell.s);
  for (const wall of walls.keys()) {
    const list = spans.filter(s => s.wall === wall);
    if (list.length) { walls[wall].unshift(evaluate(list[0], 0).s); walls[wall].push(evaluate(list.at(-1), 1).s); }
  }
  return walls;
}
