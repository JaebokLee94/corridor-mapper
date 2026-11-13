import { EchoComparison,echoProtocol } from '../../drf/echo-comparison.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeInput, generateScenario } from '../../drf/scenario.mjs';
import { buildTruthBundle, createScenarioPreparer } from '../../drf/prepare-scenario.mjs';
import { createTruthCache, getTruthCacheStats } from '../../drf/truth-cache.mjs';
import { createGrid, createField } from '../../drf/field.mjs';
import { MethodComparison, protocolForFleet } from '../../drf/comparison.mjs';
import { createPSPTEvaluator } from '../../drf/pspt-evaluate.mjs';
import { createRunEngine } from '../../drf/run-engine.mjs';
import { runExperiment } from '../../drf/sweep.mjs';

// The real worker/sweep entry points use their shared cache. Keep these test
// records out of the user's persistent cache; injected cases use memory only.
const cacheDirectory = mkdtempSync(join(tmpdir(), 'echomap-prepare-test-'));
const previousCacheDirectory = process.env.ECHOMAP_TRUTH_CACHE_DIR;
process.env.ECHOMAP_TRUTH_CACHE_DIR = cacheDirectory;
after(() => {
  if (previousCacheDirectory === undefined) delete process.env.ECHOMAP_TRUTH_CACHE_DIR;
  else process.env.ECHOMAP_TRUTH_CACHE_DIR = previousCacheDirectory;
  rmSync(cacheDirectory, { recursive: true, force: true });
});

const base = { scene: 'layered', seed: 1, vehicles: 3, snapshots: 3,
  grid: 100, cellStep: .2, roughness: 2, sigmaP: .1, sigmaD: .1 };
const memoryOnly = () => createTruthCache({ persistent: null, packaged: null });
const numerical = value => {
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map(numerical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['ms', 'psptMs', 'simulatorMs'].includes(key))
    .map(([key, item]) => [key, numerical(item)]));
  return value;
};
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}
function assertScenario(actual, expected, message) {
  assert.deepEqual(numerical(actual), numerical(expected), message);
  assert.ok(Number.isFinite(actual.simulatorMs) && actual.simulatorMs >= 0);
}
function calculate(scene) {
  const grid = createGrid(scene.input.grid, scene.input.grid, scene.domain);
  const field = createField(grid, { band: scene.input.band, perimeter: scene.input.perimeter });
  const estimator = new EchoComparison(scene.input,scene.domain);
  const guardedEvaluator = createPSPTEvaluator(scene, grid), baselineEvaluator = createPSPTEvaluator(scene, grid);
  return scene.wire.map(wire => {
    const frame = field.step(wire), methods = estimator.step(wire);
    Object.assign(frame, { methods, candidates: methods.guarded.candidates,
      psptMs: methods.guarded.ms, method: 'guarded-tuned' });
    const guarded = guardedEvaluator.step(frame,null,methods.guarded.bridges,methods.guarded.extendedBridges), echoSpline = baselineEvaluator.step({...frame,...methods.echoSpline},guarded);
    return { frame, evaluation: { ...guarded, methods: { echoSpline, guarded } } };
  });
}

test('cache miss and memory hit reproduce uncached geometry, truth and wire exactly', async () => {
  const cache = memoryOnly(), prepare = createScenarioPreparer({ cache });
  const input = Object.freeze({ ...base }), before = structuredClone(input), events = [], progress = [];
  const expected = await generateScenario(input);
  for (const source of ['generated', 'memory']) {
    const actual = await prepare(input, (t, total) => progress.push([t, total]), {
      onCache: event => events.push(event),
    });
    assertScenario(actual, expected, `${source} must preserve the full experiment`);
    assert.equal(events.at(-1).source, source);
    assert.ok(progress.every(([t, total]) => t >= 1 && t <= total && total === input.snapshots));
    assert.deepEqual(progress.at(-1), [input.snapshots, input.snapshots]);
    assert.ok(progress.every(([t], i) => !i || t >= progress[i - 1][0]));
    progress.length = 0;
  }
  assert.deepEqual(input, before, 'preparation cannot mutate caller settings');
  assert.equal(cache.stats().generated, 1);
  assert.equal(cache.stats().memory, 1);
});

test('a ten-vehicle bank supports smaller vehicle/time prefixes and fresh observation settings', async () => {
  const cache = memoryOnly(), prepare = createScenarioPreparer({ cache });
  const settings = [
    { sigmaP: 0, sigmaD: .3, resolution: 0, specular: true },
    { sigmaP: .2, sigmaD: 0, resolution: .1, specular: true },
    { sigmaP: .1, sigmaD: .05, resolution: .3, specular: false },
  ];
  let checked = 0;
  for (const seed of [1, 10]) {
    const maximum = { ...base, seed, vehicles: 10, snapshots: 4 };
    await prepare(maximum);
    for (let vehicles = 2; vehicles <= 10; vehicles++) for (const snapshots of [1, 3, 4]) for (const observation of settings) {
      const input = { ...maximum, vehicles, snapshots, ...observation }, events = [];
      const actual = await prepare(input, undefined, { onCache: event => events.push(event) });
      assert.equal(events[0].source, 'memory');
      assert.equal(events[0].vehicles, 10);
      assert.equal(events[0].snapshots, 4);
      assertScenario(actual, await generateScenario(input), `seed=${seed}, V=${vehicles}, T=${snapshots}, ${JSON.stringify(observation)}`);
      assert.equal(actual.truth.length, snapshots);
      for (const frame of actual.wire) {
        assert.equal(frame.configs.length, vehicles * (vehicles - 1) / 2);
        assert.ok(frame.configs.every(c => c.i <= vehicles && c.j <= vehicles));
      }
      checked++;
    }
  }
  assert.equal(checked, 162);
  assert.equal(cache.stats().generated, 2, 'noise, resolution, specular and V/T cannot regenerate physical paths');
  assert.equal(cache.stats().memory, checked);
});

test('mutating returned geometry, truth or measurements cannot contaminate a later cached run', async () => {
  let stored;
  const cache = createTruthCache({ packaged: null, persistent: {
    get: async () => null,
    put: async (key, bundle) => { stored = freezeDeep(bundle); },
  } });
  const prepare = createScenarioPreparer({ cache });
  const input = { ...base, snapshots: 2 };
  const expected = await generateScenario(input), first = await prepare(input), before = JSON.stringify(stored);
  first.domain[0] = -999;
  first.spans[0].C[0][0] = -999;
  first.walls[0][0][0] = -999;
  first.wallGeneration.validationFleet.vehicles = 999;
  first.truth[0].p[0][0] = -999;
  first.truth[0].poseNoise[0][0] = -999;
  const config = first.truth[0].configs[0];
  config.lambdaTotal[0] = -999;
  config.diffuseSampling.beforeThinning[0] = -999;
  config.diffuseSampling.afterThinning[0] = -999;
  config.numericalDiagnostics.degenerateSpans.push(-999);
  const point = first.truth.flatMap(s => s.configs).flatMap(c => [...c.specular, ...c.diffuse])[0];
  assert.ok(point, 'the mutation test requires an actual physical reflection');
  point.s[0] = -999;
  first.wire[0].configs[0].pHat_i[0] = -999;
  first.wire[0].configs[0].Sigma_i[0] = -999;
  const measured = first.wire.flatMap(s => s.configs).flatMap(c => c.paths)[0];
  measured.dHat = -999;
  assert.equal(JSON.stringify(stored), before);
  assertScenario(await prepare(input), expected);
});

test('physical changes invalidate the cache while ineligible seeds/fleets bypass it', async () => {
  const cache = memoryOnly(), prepare = createScenarioPreparer({ cache });
  for (const change of [{}, { roughness: 5 }, { lambda0: 12 }, { wallSide: 'upper' }]) {
    const input = { ...base, snapshots: 1, ...change }, events = [];
    const actual = await prepare(input, undefined, { onCache: event => events.push(event) });
    assert.equal(events[0].source, 'generated');
    assertScenario(actual, await generateScenario(input));
  }
  const forbiddenCache = { getTruthBundle() { assert.fail('ineligible input cannot access the truth bank'); } };
  const uncached = createScenarioPreparer({ cache: forbiddenCache });
  for (const change of [{ seed: 0 }, { seed: 11 }, { vehicles: 11 }, { vehicles: 20 }]) {
    const input = { ...base, snapshots: 1, ...change }, events = [];
    assertScenario(await uncached(input, undefined, { onCache: event => events.push(event) }), await generateScenario(input));
    assert.equal(events[0].source, 'uncached');
  }
});

test('a requested prefix does not read later raw bank snapshots and cancellation stays observable', async () => {
  const input = normalizeInput({ ...base, snapshots: 4 }), bundle = await buildTruthBundle(input);
  Object.defineProperty(bundle.truth, 2, { get() { throw new Error('future raw truth read'); } });
  const cache = { getTruthBundle: async () => ({ bundle, source: 'memory' }) };
  const prepare = createScenarioPreparer({ cache }), requested = { ...input, snapshots: 2 };
  assertScenario(await prepare(requested), await generateScenario(requested));
  await assert.rejects(prepare(requested, () => { throw new Error('Cancelled'); }), /Cancelled/);
  const fresh = createScenarioPreparer({ cache: memoryOnly() });
  await assert.rejects(fresh(requested, () => { throw new Error('Cancelled'); }), /Cancelled/);
});

test('cached wire keeps truth and future measurements outside both inference kernels', async () => {
  const prepare = createScenarioPreparer({ cache: memoryOnly() });
  await prepare({ ...base, vehicles: 10, snapshots: 4 });
  const scene = await prepare({ ...base, snapshots: 3 });
  for (const wire of scene.wire) {
    assert.deepEqual(Object.keys(wire).sort(), ['configs', 't']);
    for (const c of wire.configs) {
      assert.deepEqual(Object.keys(c).sort(), ['Sigma_i', 'Sigma_j', 'i', 'j', 'pHat_i', 'pHat_j', 'paths']);
      for (const p of c.paths) assert.deepEqual(Object.keys(p).sort(), ['dHat', 'sigmaD']);
    }
  }
  const changed = { wire: structuredClone(scene.wire) };
  for (const key of ['truth', 'walls', 'wallModel', 'seed', 'evaluation'])
    Object.defineProperty(changed, key, { get() { throw new Error(`forbidden oracle access: ${key}`); } });
  Object.defineProperty(changed.wire, 2, { get() { throw new Error('future measured snapshot read'); } });
  const grid = createGrid(100, 100, scene.domain), fields = [createField(grid), createField(grid)];
  const estimators = [new EchoComparison(scene.input,scene.domain), new EchoComparison(scene.input,scene.domain)];
  for (let t = 0; t < 2; t++) {
    assert.deepEqual(numerical(fields[0].step(scene.wire[t])), numerical(fields[1].step(changed.wire[t])));
    assert.deepEqual(numerical(estimators[0].step(scene.wire[t])), numerical(estimators[1].step(changed.wire[t])));
  }
  let oracleRead = false;
  const invalid = structuredClone(scene.wire[2]);
  Object.defineProperty(invalid, 'truth', { enumerable: true, get() { oracleRead = true; throw new Error('oracle getter invoked'); } });
  assert.throws(() => estimators[1].step(invalid), /non-wire/);
  assert.equal(oracleRead, false, 'the estimator rejects extra truth fields before reading them');
  assert.deepEqual(numerical(estimators[0].step(scene.wire[2])), numerical(estimators[1].step(scene.wire[2])),
    'a rejected truth-bearing input cannot mutate estimator state');
});

test('real run engine and sweep preserve all numerical prefixes, final metrics and fixed protocols', async () => {
  const input = { ...base, scene: 'reference', snapshots: 5, lambda0: 7 };
  const expectedScene = await generateScenario(input), expected = calculate(expectedScene), messages = [];
  const before = getTruthCacheStats();
  const engine = createRunEngine({ emit: message => messages.push(structuredClone(message)) });
  await engine.command({ type: 'start', requestId: 719, input });
  assert.deepEqual(messages.filter(m => m.type === 'error'), []);
  const prepared = messages.find(m => m.type === 'prepared');
  assert.ok(prepared);
  assertScenario(prepared.scenario, expectedScene);
  assert.deepEqual(prepared.protocol, echoProtocol(input));
  const frames = messages.filter(m => m.type === 'frame');
  assert.equal(frames.length, expected.length);
  for (let t = 0; t < expected.length; t++) {
    assert.deepEqual(numerical(frames[t].frame), numerical(expected[t].frame), `frame at t=${t + 1}`);
    assert.deepEqual(numerical(frames[t].evaluation), numerical(expected[t].evaluation), `evaluation at t=${t + 1}`);
  }
  assert.equal(messages.at(-1).mode, 'done');
  const afterEngine = getTruthCacheStats();
  assert.equal(afterEngine.generated, before.generated + 1, 'the real engine is wired to physical caching');
  const sweep = await runExperiment(input), final = expected.at(-1);
  assert.equal(getTruthCacheStats().memory, afterEngine.memory + 1, 'sweep reuses the engine physical cache');
  assert.deepEqual(sweep.protocol, echoProtocol(input));
  assert.deepEqual(sweep.wallGeneration, expectedScene.wallGeneration);
  assert.deepEqual(numerical(sweep.diagnostics), numerical(final.evaluation.diagnostics));
  for (const key of Object.keys(sweep.final)) assert.deepEqual(sweep.final[key], final.frame[key], `sweep final ${key}`);
  for (const method of ['guarded','echoSpline']) {
    const evaluation = final.evaluation.methods[method], b = evaluation.interpolation, h = b.hermite;
    const expectedMetrics = {...final.frame, ...evaluation, mapRecall:b.recall??evaluation.recall, interpolatedLengthM:b.lengthM,
      interpolatedOffWallM:b.offWallM, hermiteMapRecall:h?.recall, hermiteLengthM:h?.lengthM, hermiteOffWallM:h?.offWallM, checkedCentreMapF1:evaluation.interpolation.checked?.mapF1,rawMapF1:evaluation.interpolation.rawMap.mapF1,linearMapF1:evaluation.interpolation.mapF1,hermiteMapF1:evaluation.interpolation.hermite?.mapF1,centreMapF1:evaluation.interpolation.centre?.mapF1, centreMapRecall:evaluation.interpolation.centre?.recall, centreMapLengthM:evaluation.interpolation.centre?.lengthM, centreMapOffWallM:evaluation.interpolation.centre?.offWallM};
    for (const [key,value] of Object.entries(sweep.methods[method].summary))
      assert.deepEqual(value, expectedMetrics[key], `${method} final ${key}`);
  }
});
