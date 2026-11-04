import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateScenario } from '../../drf/scenario.mjs';
import { createScenarioPreparer } from '../../drf/prepare-scenario.mjs';
import { truthBankSourceHashes } from '../../tools/build-truth-bank.mjs';

const base = { scene: 'reference', seed: 11, vehicles: 3, snapshots: 3,
  grid: 100, cellStep: .2, roughness: 2, sigmaP: .1, sigmaD: .1 };
const forbiddenCache = { getTruthBundle() { assert.fail('Uncached settings must not access or populate the truth bank'); } };
const withoutTiming = ({ simulatorMs, ...scene }) => scene;

test('uncached worker scheduling preserves geometry, truth and noisy measurements exactly', async () => {
  const prepare = createScenarioPreparer({ cache: forbiddenCache });
  const cases = [
    { seed: 0 },
    { seed: 0xffffffff, scene: 'layered', sigmaP: .2, sigmaD: .3 },
    { seed: 11, scene: 'random', resolution: .2, specular: false },
    { seed: 1, vehicles: 11, sigmaP: 0, sigmaD: .05 },
  ];
  for (const change of cases) {
    const input = Object.freeze({ ...base, ...change }), progress = [], phases = [], cacheEvents = [];
    const expected = await generateScenario(input);
    const actual = await prepare(input, (t, total) => progress.push([t, total]), {
      onPhase: phase => phases.push(phase), onCache: event => cacheEvents.push(event),
    });
    assert.deepEqual(withoutTiming(actual), withoutTiming(expected), JSON.stringify(change));
    assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
    assert.deepEqual(phases, ['generating']);
    assert.deepEqual(cacheEvents, [{ source: 'uncached', vehicles: input.vehicles, snapshots: input.snapshots }]);
    assert.ok(Number.isFinite(actual.simulatorMs) && actual.simulatorMs >= 0);
  }
});

test('uncached generation makes progress when page timers are unavailable', async t => {
  t.mock.method(globalThis, 'setTimeout', () => { throw new Error('Timer scheduling is unavailable'); });
  const progress = [];
  const scene = await createScenarioPreparer({ cache: forbiddenCache })(base, snapshot => progress.push(snapshot));
  assert.equal(scene.wire.length, base.snapshots);
  assert.deepEqual(progress, [1, 2, 3]);
});

test('uncached generation yields between snapshots so a queued cancellation is observed', async () => {
  let release, cancelled = false, settled = false;
  const progress = [], prepare = createScenarioPreparer({ cache: forbiddenCache,
    yieldTask: () => new Promise(resolve => { release = resolve; }),
  });
  const running = prepare(base, snapshot => {
    progress.push(snapshot);
    if (cancelled) throw new Error('Cancelled');
  });
  const rejection = assert.rejects(running, /Cancelled/).then(() => { settled = true; });
  assert.deepEqual(progress, [1], 'No later snapshot runs before the worker-task yield resumes');
  assert.equal(settled, false);
  cancelled = true;
  release();
  await rejection;
  assert.deepEqual(progress, [1, 2], 'The normal progress callback stops the run before subsequent snapshots');
});

test('scheduling-only change keeps the packaged raw bank numerical provenance intact', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../assets/truth-cache/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(await truthBankSourceHashes(), manifest.sourceHashes);
});
