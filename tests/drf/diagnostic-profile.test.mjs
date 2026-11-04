import test from 'node:test';
import assert from 'node:assert/strict';
import { createSweepProfileSource } from '../../drf/diagnostic-profile.mjs';
import { generateScenario } from '../../drf/scenario.mjs';
import { diffuseProfile } from '../../drf/diffuse.mjs';

test('sweep profile reproduces the generated final snapshot for both and single walls without mutating input', async () => {
  for (const wallSide of ['both', 'upper', 'lower']) {
    const raw = Object.freeze({ scene: 'layered', wallSide, seed: 27, vehicles: 4, snapshots: 3,
      roughness: 5, cellStep: 0.2, sigmaP: 0.2, sigmaD: 0.3 }), before = { ...raw },
      scenario = await generateScenario(raw), snapshot = scenario.truth.at(-1), source = createSweepProfileSource(raw);
    assert.deepEqual(raw, before);
    assert.equal(source.t, 3);
    assert.deepEqual(source.domain, scenario.domain);
    assert.deepEqual(source.configs, [{ i: 1, j: 2 }, { i: 1, j: 3 }, { i: 1, j: 4 },
      { i: 2, j: 3 }, { i: 2, j: 4 }, { i: 3, j: 4 }]);
    assert.deepEqual(source.configs, snapshot.configs.map(({ i, j }) => ({ i, j })));
    for (const index of [0, 5]) {
      const { i, j } = snapshot.configs[index], actual = source.profile(index),
        expected = diffuseProfile(scenario.spans, snapshot.p[i - 1], snapshot.p[j - 1],
          scenario.input.roughness * Math.PI / 180, scenario.input.lambda0, scenario.input.cellStep);
      assert.deepEqual(actual, expected, 'Use the same final truth positions as the existing eval worker');
      assert.ok(actual.cells.length > 0);
      assert.deepEqual([...new Set(actual.cells.map(cell => cell.wall))].sort(),
        wallSide === 'both' ? [0, 1] : [wallSide === 'upper' ? 1 : 0]);
      assert.strictEqual(source.profile(index), actual, 'Repeated selection reuses the last pair profile');
    }
  }
});

test('zero roughness is a valid empty diffuse profile and invalid pairs are rejected', () => {
  const source = createSweepProfileSource({ seed: 27, vehicles: 2, snapshots: 1, roughness: 0, cellStep: 0.2 });
  assert.deepEqual(source.configs, [{ i: 1, j: 2 }]);
  assert.deepEqual(source.profile(0).cells, []);
  assert.ok(source.profile(0).lambdaTotal.every(value => value === 0));
  for (const invalid of [-1, 1, 0.5, '0', null, NaN]) assert.throws(() => source.profile(invalid), RangeError);
});
