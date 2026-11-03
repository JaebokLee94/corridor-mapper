import test from 'node:test';
import assert from 'node:assert/strict';
import { facetSinDelta } from '../../drf/specular.mjs';

// Pre-optimization vector form. This is a behavior-preservation check, alongside
// the independent mirror-root and continuous-angle checks in truth-model.test.
function vectorFacet(t, s, pT, pR) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  const a = [pT[0] - s[0], pT[1] - s[1]], b = [pR[0] - s[0], pR[1] - s[1]],
    ra = Math.hypot(...a), rb = Math.hypot(...b), speed = Math.hypot(...t);
  if (!(ra > 0 && rb > 0 && speed > 0)) return NaN;
  const ua = a.map(v => v / ra), ub = b.map(v => v / rb);
  if (dot(ua, ub) >= 0) {
    const sum = [ua[0] + ub[0], ua[1] + ub[1]], orientation = Math.sign(cross(a, b));
    if (!orientation) return NaN;
    return orientation * dot(t, sum) / (speed * Math.hypot(...sum));
  }
  const difference = [ub[0] - ua[0], ub[1] - ua[1]];
  return cross(t, difference) / (speed * Math.hypot(...difference));
}

test('scalar facet angle exactly preserves vector arithmetic and degenerate branches', () => {
  let seed = 271828;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let k = 0; k < 2000; k++) {
    const points = Array.from({ length: 4 }, () => [200 * (random() - .5), 200 * (random() - .5)]);
    assert.equal(facetSinDelta(...points), vectorFacet(...points), `facet ${k}`);
  }
  for (const points of [
    [[1, 0], [0, 0], [-1, 3], [1, 3]], [[1, 0], [0, 0], [-1, 0], [1, 0]],
    [[0, 0], [0, 0], [-1, 3], [1, 3]], [[1, 0], [0, 0], [0, 0], [1, 3]],
    [[1, 0], [0, 0], [1, 1], [2, 2]], [[1, 0], [0, 0], [1, 1], [1 + 1e-15, 1]],
  ]) assert.equal(facetSinDelta(...points), vectorFacet(...points));
});
