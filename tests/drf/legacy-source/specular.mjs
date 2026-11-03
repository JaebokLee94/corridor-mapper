import { evaluate } from './wall.mjs';
import { add, multiply, derivative, rootInfo, realRoots } from './poly.mjs';

export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const FERMAT_ROUNDOFF = 64 * Number.EPSILON;
function leg(s, p) { const a = [s[0] - p[0], s[1] - p[1]], r = Math.hypot(...a); return { a, r }; }
export function sameSide(t, s, pT, pR) { return cross(t, leg(s, pT).a) * cross(t, leg(s, pR).a) > 0; }
export function facetSinDelta(t, s, pT, pR) {
  const a = [pT[0] - s[0], pT[1] - s[1]], b = [pR[0] - s[0], pR[1] - s[1]], ra = Math.hypot(...a), rb = Math.hypot(...b), speed = Math.hypot(...t);
  if (!(ra > 0 && rb > 0 && speed > 0)) return NaN;
  const ua = a.map(v => v / ra), ub = b.map(v => v / rb);
  if (dot(ua, ub) >= 0) {
    const sum = [ua[0] + ub[0], ua[1] + ub[1]], orientation = Math.sign(cross(a, b));
    if (!orientation) return NaN;
    // u_R-u_T is parallel to sign(cross(u_T,u_R))*perp(u_T+u_R).
    // This identity avoids cancellation when the two vehicle directions almost coincide.
    return orientation * dot(t, sum) / (speed * Math.hypot(...sum));
  }
  const difference = [ub[0] - ua[0], ub[1] - ua[1]];
  return cross(t, difference) / (speed * Math.hypot(...difference));
}
export function specularPolynomial(span, pT, pR) {
  const sx = span.C.map(row => row[0]), sy = span.C.map(row => row[1]), tx = derivative(sx), ty = derivative(sy);
  const ax = sx.slice(), ay = sy.slice(), bx = sx.slice(), by = sy.slice();
  ax[0] -= pT[0]; ay[0] -= pT[1]; bx[0] -= pR[0]; by[0] -= pR[1];
  const ta = add(multiply(tx, ax), multiply(ty, ay)), tb = add(multiply(tx, bx), multiply(ty, by));
  const ca = add(multiply(tx, ay), multiply(ty, ax), -1), cb = add(multiply(tx, by), multiply(ty, bx), -1);
  // Fermat stationary path condition with the same-side filter removes the other bisector.
  return add(multiply(ta, cb), multiply(tb, ca));
}
export function refineSpecularRoot(span, initialU, pT, pR) {
  let u = initialU;
  // Unsquared Fermat residual reduces power-basis cancellation at simple roots.
  for (let n = 0; n < 5; n++) {
    const { s, t, dd } = evaluate(span, u), a = leg(s, pT), b = leg(s, pR);
    if (!(a.r > 0 && b.r > 0)) break;
    const ga = a.a.map(v => v / a.r), gb = b.a.map(v => v / b.r), g = [ga[0] + gb[0], ga[1] + gb[1]];
    const f = dot(t, g), df = dot(dd, g) + (dot(t, t) - dot(t, ga) ** 2) / a.r + (dot(t, t) - dot(t, gb) ** 2) / b.r;
    // Near a caustic, df cancels curvature and range terms. Avoid dividing by
    // roundoff; ordinary roots retain the same five Newton updates.
    const derivativeScale = Math.abs(dot(dd, g)) + dot(t, t) * (1 / a.r + 1 / b.r);
    if (!Number.isFinite(df) || Math.abs(df) <= FERMAT_ROUNDOFF * derivativeScale) break;
    const next = u - f / df;
    if (!(next >= 0 && next <= 1)) break;
    const candidate = evaluate(span, next), ca = leg(candidate.s, pT), cb = leg(candidate.s, pR);
    const cg = [ca.a[0] / ca.r + cb.a[0] / cb.r, ca.a[1] / ca.r + cb.a[1] / cb.r];
    const residual = Math.abs(f) / (Math.hypot(...t) * Math.hypot(...g));
    const candidateResidual = Math.abs(dot(candidate.t, cg)) / (Math.hypot(...candidate.t) * Math.hypot(...cg));
    // Preserve ULP updates inside the Float64 floor, but reject a worsening jump.
    if (!Number.isFinite(candidateResidual) || candidateResidual > Math.max(residual, FERMAT_ROUNDOFF)) break;
    u = next;
  }
  return u;
}
/** Visibility via exact cubic line intersections. AABB culling uses the
 * Bezier control hull, not sampled curve bounds. */
export function visible(spans, p, q) {
  const d = [q[0] - p[0], q[1] - p[1]], distance2 = dot(d, d);
  if (!distance2) return false;
  const box = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
  for (const span of spans) {
    const a = span.aabb;
    if (a[2] < box[0] - 1e-12 || a[0] > box[2] + 1e-12 || a[3] < box[1] - 1e-12 || a[1] > box[3] + 1e-12) continue;
    const line = span.C.map((row, i) => cross(d, [row[0] - (i ? 0 : p[0]), row[1] - (i ? 0 : p[1])]));
    const info = rootInfo(line);
    if (info.degenerate) {
      const projection = span.C.map((row, i) => dot([row[0] - (i ? 0 : p[0]), row[1] - (i ? 0 : p[1])], d) / distance2);
      const samples = [0, 1, ...realRoots(derivative(projection))].map(u => dot(leg(evaluate(span, u).s, p).a, d) / distance2);
      if (Math.max(...samples) > 1e-9 && Math.min(...samples) < 1 - 1e-7) return false;
    }
    for (const u of info.roots) {
      const lambda = dot(leg(evaluate(span, u).s, p).a, d) / distance2;
      if (lambda > 1e-9 && lambda < 1 - 1e-7) return false;
    }
  }
  return true;
}
export function specularPoints(spans, pT, pR) {
  const points = [], diagnostics = { degenerateSpans: [], unresolved: 0, nearMultiple: 0 };
  for (const span of spans) {
    const info = rootInfo(specularPolynomial(span, pT, pR));
    if (info.degenerate) diagnostics.degenerateSpans.push(span.span);
    // A near-multiple cluster does not certify the number of distinct roots.
    diagnostics.unresolved += info.unresolved + (info.nearMultiple || 0);
    diagnostics.nearMultiple += info.nearMultiple || 0;
    for (let u of info.roots) {
      if (u === 1 && !span.last) continue;
      const initial = evaluate(span, u);
      if (!sameSide(initial.t, initial.s, pT, pR)) continue;
      u = refineSpecularRoot(span, u, pT, pR);
      const { s, t, dd } = evaluate(span, u), a = leg(s, pT), b = leg(s, pR);
      if (!(a.r > 0 && b.r > 0 && sameSide(t, s, pT, pR) && visible(spans, pT, s) && visible(spans, pR, s))) continue;
      const g = [a.a[0] / a.r + b.a[0] / b.r, a.a[1] / a.r + b.a[1] / b.r], norm = Math.hypot(...g), speed = Math.hypot(...t);
      const residual = Math.abs(dot(t, g)) / (speed * norm);
      if (!Number.isFinite(residual) || residual > FERMAT_ROUNDOFF) { diagnostics.unresolved++; continue; }
      const cth = norm / 2, left = [-t[1] / speed, t[0] / speed], toward = [-g[0] / norm, -g[1] / norm];
      const kappa = cross(t, dd) / speed ** 3 * Math.sign(dot(left, toward));
      const point = { s, span: span.span, u, rho: a.r + b.r, cth, dkap: cth * (1 / a.r + 1 / b.r) / 2 - kappa, wall: span.wall };
      const duplicate = points.findIndex(p => p.wall === span.wall && Math.hypot(p.s[0] - s[0], p.s[1] - s[1]) < 1e-10);
      if (duplicate < 0) points.push(point);
      else if (u < 2e-12) points[duplicate] = point;
    }
  }
  points.diagnostics = diagnostics;
  return points;
}
