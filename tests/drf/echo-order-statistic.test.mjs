import test from 'node:test';
import assert from 'node:assert/strict';
import { exactMedian, exactQuantile } from '../../drf/order-statistic.mjs';

test('spline and GBDT rank selection reproduces sorted interpolation, including duplicate heights', () => {
  for (const length of [1, 2, 5, 31, 32, 33, 101, 500]) {
    const values = Float64Array.from({length}, (_, i) => ((i * 73) % 29 - 14) / 7);
    for (const data of [values, values.slice().sort(), values.slice().sort().reverse(), values.slice().fill(3)]) {
      const sorted = data.slice().sort(), middle = length >> 1;
      assert.equal(exactMedian(data.slice()), length % 2 ? sorted[middle] : (sorted[middle-1] + sorted[middle]) / 2);
      const work = data.slice();
      let first = 0;
      for (const q of [.15, .5, .85]) {
        const at = (length - 1) * q, k = Math.floor(at);
        const expected = sorted[k] + (at - k) * (sorted[Math.min(k+1, length-1)] - sorted[k]);
        assert.equal(exactQuantile(work, q, first), expected);
        if (length >= 32) first = k + 1;
      }
    }
  }
});
