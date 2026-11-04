import test from 'node:test';
import assert from 'node:assert/strict';
import { PSPT, prepareMeasuredSnapshot } from '../../drf/pspt.mjs';

function measured(ranges) {
  return { t: 1, configs: [{ i: 1, j: 2, pHat_i: [0, 0], pHat_j: [.1, 0],
    Sigma_i: [0, 0, 0], Sigma_j: [0, 0, 0],
    paths: ranges.map(dHat => ({ dHat, sigmaD: 1 / 6 })) }] };
}
const clusters = (ranges, clustering = 'bounded-span') =>
  prepareMeasuredSnapshot(measured(ranges), { clustering }).pre[0].cl;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12,
  `actual ${actual}, expected ${expected}`);

test('bounded-span splits a chained cluster using the existing physical range gate', () => {
  // Zero pose covariance and sigmaD=1/6 give gap=3*sigmaD=.5 m.
  // Translate [0,.4,.8] by 1 m so all returns exceed the .1 m baseline.
  const actual = clusters([1, 1.4, 1.8]);
  assert.equal(actual.length, 2);
  assert.deepEqual(actual.map(c => c[1]), [2, 1]);
  close(actual[0][0], 1.2);
  close(actual[0][2], .08); // (1-1.2)^2 + (1.4-1.2)^2
  close(actual[1][0], 1.8);
  close(actual[1][2], 0);
  assert.equal(clusters([1, 1.4, 1.8], 'single-link').length, 1);
});

test('bounded-span includes the gate boundary, splits above it and retains compact clusters', () => {
  assert.equal(clusters([1, 1.5]).length, 1);
  assert.equal(clusters([1, 1.500001]).length, 2);
  assert.equal(clusters([1, 1.2, 1.4]).length, 1);
  assert.deepEqual(clusters([]), []);
  assert.deepEqual(clusters([1]), [[1, 1, 0]]);
});

test('range order does not affect bounded clusters and input measurements remain unchanged', () => {
  const input = measured([1.8, 1, 1.4]), before = structuredClone(input);
  const shuffled = prepareMeasuredSnapshot(input, { clustering: 'bounded-span' });
  assert.deepEqual(shuffled.pre[0].cl, clusters([1, 1.4, 1.8]));
  assert.deepEqual(input, before);
});

test('PSPT forwards clustering mode while legacy preparation stays single-link by default', () => {
  const wire = measured([1, 1.4, 1.8]);
  assert.equal(new PSPT().clustering, 'single-link');
  assert.deepEqual(prepareMeasuredSnapshot(wire), prepareMeasuredSnapshot(wire, { clustering: 'single-link' }));
  for (const [clustering, expected] of [['single-link', 1], ['bounded-span', 2]]) {
    const model = new PSPT({ nx: 5, ny: 5, clustering });
    model.step(wire);
    assert.equal(model.hist[0][1][0].cl.length, expected);
  }
  // Baseline B uses preparation with no options. An explicit PSPT opt-in must
  // not change that shared function's default or mutate a module-wide setting.
  assert.equal(prepareMeasuredSnapshot(wire).pre[0].cl.length, 1);
});

test('unknown clustering modes and preparation keys reject before input access', () => {
  for (const clustering of ['bounded', 'single', '', null, undefined, false, 0, {}]) {
    assert.throws(() => new PSPT({ clustering }), /clustering/);
    assert.throws(() => prepareMeasuredSnapshot(measured([1]), { clustering }), /clustering/);
  }
  assert.throws(() => prepareMeasuredSnapshot(measured([1]), { seed: 1 }), /preparation options/);
  let accessed = false;
  const options = {};
  Object.defineProperty(options, 'clustering', { get() { accessed = true; return 'bounded-span'; } });
  assert.throws(() => prepareMeasuredSnapshot(measured([1]), options), /accessor/);
  assert.equal(accessed, false);
});
