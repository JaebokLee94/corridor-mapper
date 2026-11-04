import { wallCells, evaluate } from './wall.mjs';
import { facetSinDelta, sameSide, visible } from './specular.mjs?v=20261002-model8';

export function diffuseProfile(spans, pT, pR, sigmaRad, lambda0, cellStep, { partition = 'arc' } = {}) {
  if (!(Number.isFinite(sigmaRad) && sigmaRad >= 0 && Number.isFinite(lambda0) && lambda0 >= 0)) throw new RangeError('Roughness and intensity must be finite and nonnegative');
  const lambdaTotal = Array(Math.max(1, ...spans.map(s => s.wall)) + 1).fill(0);
  if (!sigmaRad || !lambda0) return { cells: [], lambdaTotal };
  const cells = wallCells(spans, cellStep, partition).map(cell => {
    // Both directions point toward the vehicles: their DIFFERENCE is the facet tangent.
    const sinDelta = facetSinDelta(cell.t, cell.s, pT, pR), sine = Math.max(-1, Math.min(1, sinDelta));
    const tan2 = sine ** 2 / (1 - sine ** 2), w = Number.isFinite(tan2) ? Math.exp(-tan2 / (2 * sigmaRad ** 2)) : 0;
    const lambda = lambda0 * w * cell.ds;
    lambdaTotal[cell.wall] += lambda;
    return { ...cell, delta: Math.asin(sine), w, lambda };
  });
  return { cells, lambdaTotal };
}
/** Global Poisson + categorical sampling is exactly independent cell counts
 * N_n~Poisson(lambda_n), followed by same-side/visibility thinning.
 * Optional diagnostics.generated records the Poisson draw before thinning. */
export function sampleDiffuse(spans, pT, pR, profile, rng, diagnostics) {
  const cumulative = new Float64Array(profile.cells.length);
  let total = 0;
  for (let i = 0; i < cumulative.length; i++) cumulative[i] = total += profile.cells[i].lambda;
  if (diagnostics) diagnostics.generated = 0;
  if (!total) return [];
  const count = rng.poisson(total), bySpan = new Map(spans.map(span => [span.span, span])), points = [];
  if (diagnostics) diagnostics.generated = count;
  for (let i = 0; i < count; i++) {
    const target = rng.uniform() * total;
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cumulative[mid] > target) hi = mid; else lo = mid + 1; }
    const cell = profile.cells[lo], span = bySpan.get(cell.span), u = cell.u + (rng.uniform() - 0.5) * cell.du, { s, t } = evaluate(span, u);
    if (sameSide(t, s, pT, pR) && visible(spans, pT, s) && visible(spans, pR, s)) {
      points.push({ s, span: span.span, u, rho: Math.hypot(s[0] - pT[0], s[1] - pT[1]) + Math.hypot(s[0] - pR[0], s[1] - pR[1]), wall: span.wall });
    }
  }
  return points;
}
