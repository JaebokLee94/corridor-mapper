import test from 'node:test';
import assert from 'node:assert/strict';
import { Surfel, mirrored, refine } from '../../drf/pspt-math.mjs';

// Subclasses use the unchanged scalar loop. This oracle tests cache equivalence;
// independent analytic/Python correctness remains in pspt-math.test.mjs.
class UncachedSurfel extends Surfel {}
const constructors = [Surfel, UncachedSurfel];
const surfaces = () => constructors.map(Type => new Type([0, 0], .15, [0, 1], 3));
const positions = Array.from({ length: 10 }, (_, i) => [(i - 4.5) * .6, 3 + i * .11]);
function compare(actual, expected, options = {}) {
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++)
    assert.deepStrictEqual(actual.predict(positions[i], positions[j], options), expected.predict(positions[i], positions[j], options));
}

test('sampled geometry and vehicle reuse preserve every float64 prediction value', () => {
  const [actual, expected] = surfaces();
  for (let repeat = 0; repeat < 3; repeat++) compare(actual, expected);
  const mutations = [
    s => { s.x[0] = .1; }, s => { s.x[1] += .2; }, s => { s.x[2] = .07; },
    s => { s.x = [0, -.12, -.01]; }, s => { s.c0[0] = .3; }, s => { s.c0[1] = -.2; },
    s => { s.nu0[0] = .02; }, s => { s.nu0[1] = .98; }, s => { s.sg = -1; },
    s => { s.sg = 1; s.ell = 1.5; }, s => { s.c0 = [-0, 0]; s.x[0] = -0; },
  ];
  for (const mutate of mutations) {
    mutate(actual); mutate(expected);
    for (const options of [{ ext: 1 }, { ext: 1.5 }, { ext: 2, nuGrid: 17 }, { ext: 2, nuGrid: 258 }])
      compare(actual, expected, options);
  }
  const reflected = [actual, expected].map(s => mirrored(s, [0, 1], [[1, 0], [0, -1]], 0));
  Object.setPrototypeOf(reflected[1], UncachedSurfel.prototype);
  compare(...reflected);
});

test('cache is per surface, bounded, and never aliases public return values', () => {
  const [actual, expected] = surfaces();
  compare(actual, expected);
  const frame = actual.frame(); frame[0][0] = 999; frame[1][1] = 999; frame[2][0] = 999;
  const result = actual.predict(positions[0], positions[1]);
  assert.ok(result); result[2][0] = 999; result[3][0] = 999; result[4][0] = 999;
  compare(actual, expected);
  for (let i = 0; i < 70; i++) {
    const p = [i * .05, 2.5], q = [i * .05 + .3, 3];
    assert.deepStrictEqual(actual.predict(p, q), expected.predict(p, q));
  }
  compare(actual, expected);
  const other = new Surfel([.2, -.3], -.3, [0, 1], 2);
  const otherUncached = new UncachedSurfel([.2, -.3], -.3, [0, 1], 2);
  compare(other, otherUncached); compare(actual, expected);
  for (const [p, q] of [[[0, 0], [1, 3]], [[-0, 0], [1, 3]], [[0, -0], [-0, -0]], [[-1, -3], [1, -3]]])
    assert.deepStrictEqual(actual.predict(p, q), expected.predict(p, q));
});

test('input validation still runs when geometry and positions are cached', () => {
  const [actual, expected] = surfaces(); compare(actual, expected);
  for (const args of [ [[0, NaN], [1, 2]], [[0], [1, 2]], [[0, 1], [1, 2], { ext: 0 }],
    [[0, 1], [1, 2], { nuGrid: 1 }], [[0, 1], [1, 2], { nuGrid: 2.5 }] ]) {
    assert.throws(() => actual.predict(...args), RangeError);
    assert.throws(() => expected.predict(...args), RangeError);
  }
});

test('ten-vehicle reuse computes grid distances once per vehicle, not once per pair', () => {
  const [actual, expected] = surfaces(), hypot = Math.hypot;
  let calls = 0, accepted = 0;
  try {
    Math.hypot = (...args) => { calls++; return hypot(...args); };
    for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++)
      if (actual.predict(positions[i], positions[j])) accepted++;
    assert.equal(calls, 10 * 41 + 2 * accepted);
    calls = 0;
    for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) expected.predict(positions[i], positions[j]);
    assert.equal(calls, 45 * 2 * 41 + 2 * accepted);
  } finally { Math.hypot = hypot; }
});

test('repeated MAP iterations preserve rows, state and covariance in both modes', () => {
  const truth = new UncachedSurfel([0, 0], .15, [0, 1], 3);
  truth.x = [.12, .18, .025];
  const snapshots = Array.from({ length: 4 }, (_, t) => {
    const points = positions.slice(0, 5).map(([x, y]) => [x + .05 * t, y + .03 * t]);
    const configs = [];
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const prediction = truth.predict(points[i], points[j], { ext: 1 });
      if (prediction) configs.push({ i, j, pi: points[i], pj: points[j], Si: [[.01, .001], [.001, .02]],
        Sj: [[.01, .001], [.001, .02]], sr2: .01, cl: [[prediction[0] + .001 * t, 2, 0]] });
    }
    return configs;
  });
  assert.ok(snapshots.every(configs => configs.length > 0));
  for (const refinement of ['independent-pairs', 'shared-pose']) {
    const [actual, expected] = surfaces();
    assert.equal(refine(actual, snapshots, { refinement }), refine(expected, snapshots, { refinement }));
    assert.deepStrictEqual(actual.x, expected.x);
    assert.deepStrictEqual(actual.P, expected.P);
    compare(actual, expected);
  }
});
