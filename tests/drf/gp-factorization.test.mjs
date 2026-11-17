import test from 'node:test';
import assert from 'node:assert/strict';
import { neuralRuntime } from '../../drf/model-runtime.mjs';

test('FP64 GPR preserves dense reference predictions across odd block splits and repeated locations', async () => {
  const runtime = await neuralRuntime('gat');
  const queries = [2, 7, 15];
  // Independent PyTorch FP64 covariance solve and SciPy L-BFGS-B, rounded to eight decimals.
  const reference = [
    [31, [0.49185412, -0.09980978, 1.19205778]],
    [33, [0.49176004, -0.09897267, 1.18751821]],
    [67, [0.57098504, -0.12969037, 1.02995186]],
    [137, [0.87160827, -0.43443295, 0.86590517]],
  ];
  for (const [n, expected] of reference) {
    const x = Array.from({ length: n }, (_, i) => ((i * 17) % 53) / 3);
    const y = x.map((v, i) => Math.sin(0.51 * v) + ((i * 7) % 11 - 5) * 0.11);
    const result = runtime.call('gaussianProcess', [x, y, queries], queries.length, [n], Float64Array);
    for (let i = 0; i < queries.length; i++) {
      assert.ok(Math.abs(result[i] - expected[i]) < 1e-7, `n=${n}, x=${queries[i]}, got ${result[i]}`);
    }
  }
});
