import test from 'node:test';
import assert from 'node:assert/strict';
import { Surfel, dot } from '../../drf/pspt-math.mjs';

// Frozen pre-optimization sampled-root calculation from a2c7f0f. This checks
// numerical behavior preservation; independent Python state/Jacobian fixtures
// remain in pspt-math.test.mjs and are not replaced by this regression oracle.
function arrayPrediction(surface, pi, pj, { ext = 2, nuGrid = 41 } = {}) {
  const add = (a, b, scale = 1) => a.map((value, i) => value + scale * b[i]);
  const [center, tangent, normal, curvature] = surface.frame();
  const u = Array.from({ length: nuGrid }, (_, i) => -ext * surface.ell + i * (2 * ext * surface.ell / (nuGrid - 1)));
  const point = at => add(add(center, tangent, at), normal, 0.5 * curvature * at * at);
  const residuals = u.map(at => {
    const s = point(at), di = add(s, pi, -1), dj = add(s, pj, -1);
    const ri = Math.hypot(...di), rj = Math.hypot(...dj);
    if (!ri || !rj) return NaN;
    return dot(add(tangent, normal, curvature * at), di.map((value, k) => value / ri + dj[k] / rj));
  });
  let us = null;
  for (let i = 0; i + 1 < nuGrid; i++) if (residuals[i] * residuals[i + 1] <= 0) {
    const difference = residuals[i + 1] - residuals[i];
    const root = u[i] - residuals[i] * (u[i + 1] - u[i]) / (Math.abs(difference) < 1e-15 ? 1e-15 : difference);
    if (us === null || Math.abs(root) < Math.abs(us)) us = root;
  }
  if (us === null) return null;
  const s = point(us);
  if (dot(add(pi, s, -1), normal) <= 0 || dot(add(pj, s, -1), normal) <= 0) return null;
  const di = add(s, pi, -1), dj = add(s, pj, -1), ri = Math.hypot(...di), rj = Math.hypot(...dj);
  if (!ri || !rj) return null;
  const ei = di.map(value => value / ri), ej = dj.map(value => value / rj), g = add(ei, ej);
  const derivative = [dot(g, surface.nu0), surface.sg * dot(g, add(normal.map(value => us * value), tangent, -0.5 * curvature * us * us)),
    0.5 * us * us * dot(g, normal)];
  return [ri + rj, us, derivative, ei, ej];
}

test('allocation-free sampled roots exactly preserve the former float64 calculation', () => {
  let seed = 161803398;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
  let accepted = 0, rejected = 0;
  for (let k = 0; k < 600; k++) {
    const center = [80 * random(), 60 * random() - 20], phi = (random() - .5) * 2 * Math.PI;
    const surface = new Surfel(center, phi, [random() - .5, random() - .5], .2 + 3 * random());
    surface.x = [(random() - .5) * 4, phi + (random() - .5), (random() - .5) * 1.5];
    const pi = center.map(v => v + 16 * (random() - .5)), pj = center.map(v => v + 16 * (random() - .5));
    const options = { ext: [1, 1.5, 2, 3][k % 4], nuGrid: [2, 21, 41, 97][k % 4] };
    const expected = arrayPrediction(surface, pi, pj, options);
    assert.deepEqual(surface.predict(pi, pj, options), expected, `same root, Jacobian and unit vectors for case ${k}`);
    expected === null ? rejected++ : accepted++;
  }
  assert.ok(accepted > 25 && rejected > 25, 'exercise both valid and rejected stationary roots');
});

test('flat symmetric geometry has the analytic midpoint root and rejects a focal singularity', () => {
  const surface = new Surfel([0, 0], 0, [0, 1], 2);
  const prediction = surface.predict([-1, 3], [1, 3]);
  assert.ok(prediction);
  assert.equal(prediction[1], 0);
  assert.equal(prediction[0], 2 * Math.hypot(1, 3));
  assert.deepEqual(prediction, arrayPrediction(surface, [-1, 3], [1, 3]));
  for (const [pi, pj] of [[[0, 0], [1, 3]], [[-1, -3], [1, -3]], [[0, 0], [0, 0]]])
    assert.deepEqual(surface.predict(pi, pj), arrayPrediction(surface, pi, pj));
});
