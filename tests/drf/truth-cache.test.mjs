import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { TRUTH_CACHE_SCHEMA, TRUTH_CACHE_GENERATOR, truthCacheKey, validateTruthBundle,
  createTruthCache, createNodeStore, createPackagedStore } from '../../drf/truth-cache.mjs';

const input = { scene: 'reference', wallSide: 'both', vehicles: 2, snapshots: 2, seed: 1,
  sigmaP: .1, sigmaD: .1, sigmaM: 6, deltaM: 20, sigmaDGeometry: .33, deltaD: 4,
  roughness: 2, lambda0: 10, cellStep: .02, resolution: 0, specular: true, grid: 150, band: 4, perimeter: 'exact' };
const noBuild = () => { throw new Error('Unexpected physical generation'); };
function fixture(settings = input) {
  return { schema: TRUTH_CACHE_SCHEMA, key: truthCacheKey(settings), vehicles: settings.vehicles, snapshots: settings.snapshots,
    geometry: { spans: [{ C: [[0, 0], [100, 0], [0, 0], [0, 0]], span: 1, wall: 0, aabb: [0, 0, 100, 0] }],
      walls: [[[0, 0], [100, 0]]], domain: [0, 100, -5, 30], wallModel: null },
    truth: Array.from({ length: settings.snapshots }, (_, t) => {
      const p = Array.from({ length: settings.vehicles }, (_, v) => [v + t, 2]);
      const configs = [];
      for (let i = 1; i <= settings.vehicles; i++) for (let j = i + 1; j <= settings.vehicles; j++) configs.push({ i, j,
        specular: [{ s: [(i + j) / 2, 0], span: 1, wall: 0, u: (i + j) / 200, rho: Math.sqrt(17), cth: .9, dkap: .5 }],
        diffuse: [{ s: [Math.PI, 0], span: 1, wall: 0, u: Math.PI / 100, rho: Math.sqrt(19) }],
        lambdaTotal: [1, 0], diffuseSampling: { beforeThinning: [1, 0], afterThinning: [1, 0] },
        generated: { specular: 1, diffuse: 1 }, numericalDiagnostics: { degenerateSpans: [], unresolved: 0 } });
      return { t: t + 1, p, configs };
    }) };
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'echomap-truth-test-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');

test('canonical physical key excludes all noise, observation and estimator controls', () => {
  const changed = { ...input, sigmaP: 1, sigmaD: 2, vehicles: 10, snapshots: 120,
    specular: false, resolution: .5, grid: 100, band: 'full', perimeter: 'ramanujan' };
  assert.equal(truthCacheKey(input), truthCacheKey(changed));
  assert.equal(truthCacheKey(input), truthCacheKey(Object.fromEntries(Object.entries(input).reverse())));
  assert.deepEqual(Object.keys(JSON.parse(truthCacheKey(input))), ['schema', 'generator', 'seed', 'scene', 'wallSide',
    'sigmaM', 'deltaM', 'sigmaDGeometry', 'deltaD', 'roughness', 'lambda0', 'cellStep']);
  assert.equal(JSON.parse(truthCacheKey(input)).generator, TRUTH_CACHE_GENERATOR);
  for (const field of ['seed', 'sigmaM', 'deltaM', 'sigmaDGeometry', 'deltaD', 'roughness', 'lambda0', 'cellStep'])
    assert.notEqual(truthCacheKey(input), truthCacheKey({ ...input, [field]: input[field] + .1 }), field);
  for (const [field, value] of [['scene', 'random'], ['wallSide', 'upper']])
    assert.notEqual(truthCacheKey(input), truthCacheKey({ ...input, [field]: value }));
  assert.throws(() => truthCacheKey({ ...input, roughness: NaN }), /Invalid normalized/);
});

test('fresh truth is reused without mutation for new measurement noise; insufficient capacity rebuilds', async () => {
  const cache = createTruthCache({ persistent: null, packaged: null });
  const raw = fixture(), saved = structuredClone(raw);
  const generated = await cache.getTruthBundle(input, () => raw);
  assert.equal(generated.source, 'generated');
  const reused = await cache.getTruthBundle({ ...input, sigmaD: .3, sigmaP: .5, specular: false }, noBuild);
  assert.equal(reused.source, 'memory'); assert.equal(reused.bundle, generated.bundle);
  assert.deepEqual(raw, saved);
  const larger = { ...input, vehicles: 3, snapshots: 3 };
  assert.equal((await cache.getTruthBundle(larger, () => fixture(larger))).source, 'generated');
  assert.equal((await cache.getTruthBundle(input, noBuild)).bundle.vehicles, 2);
  assert.equal(cache.stats().memoryEntries, 2);
});

test('memory capacity is bounded and same-key concurrent generation is shared', async () => {
  const cache = createTruthCache({ persistent: null, packaged: null });
  let finish, calls = 0;
  const build = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = cache.getTruthBundle(input, build), second = cache.getTruthBundle(input, build);
  await new Promise(resolve => setImmediate(resolve)); finish(fixture());
  assert.deepEqual(await first, await second); assert.equal(calls, 1);
  for (const seed of [2, 3]) await cache.getTruthBundle({ ...input, seed }, () => fixture({ ...input, seed }));
  assert.equal(cache.stats().memoryEntries, 2);
  assert.equal((await cache.getTruthBundle(input, () => fixture())).source, 'generated');
});

test('unsupported seeds and fleets bypass every cache adapter', async () => {
  const failStore = { get: noBuild, put: noBuild };
  const cache = createTruthCache({ persistent: failStore, packaged: failStore });
  for (const settings of [{ ...input, seed: 0 }, { ...input, seed: 11 }, { ...input, vehicles: 11 }])
    assert.equal((await cache.getTruthBundle(settings, () => fixture(settings))).source, 'uncached');
  assert.equal(cache.stats().uncached, 3); assert.equal(cache.stats().memoryEntries, 0);
});

test('persistent and packaged hits preserve provenance without recompressing packaged assets', async () => {
  const cache = createTruthCache({ persistent: { get: () => null, put: noBuild },
    packaged: { get: (key, requested) => { assert.equal(requested.vehicles, 2); return fixture(); } } });
  const result = await cache.getTruthBundle(input, noBuild);
  assert.equal(result.source, 'packaged'); assert.equal(cache.stats().cacheWriteErrors, 0);
  const freshWorker = createTruthCache({ persistent: { get: () => result.bundle }, packaged: { get: noBuild } });
  assert.equal((await freshWorker.getTruthBundle(input, noBuild)).source, 'persistent');
});

test('cache I/O, invalid tags, truncated time/pairs and nonfinite positions fall back to generation', async () => {
  const badMutations = [
    b => { b.schema = 'old'; }, b => { b.key = 'other'; }, b => { b.truth.pop(); },
    b => { b.truth[1].t = 9; }, b => { b.truth[0].p[0][0] = Infinity; },
    b => { b.truth[0].configs.pop(); }, b => { b.truth[0].configs[0].j = 1; },
    b => { b.truth[0].configs[0].diffuse[0].rho = NaN; },
    b => { b.truth[0].configs[0].diffuse[0].z = 0; },
    b => { b.truth[0].poseNoise = [[0, 0], [0, 0]]; },
  ];
  for (const mutate of badMutations) {
    const invalid = fixture(); mutate(invalid); assert.equal(validateTruthBundle(invalid, input), false);
    const cache = createTruthCache({ persistent: { get: () => invalid, put: () => { throw new Error('quota'); } }, packaged: null });
    assert.equal((await cache.getTruthBundle(input, fixture)).source, 'generated');
    assert.equal(cache.stats().invalidEntries, 1); assert.equal(cache.stats().cacheWriteErrors, 1);
  }
  const cache = createTruthCache({ persistent: { get: () => { throw new Error('permission'); } }, packaged: { get: () => { throw new Error('404'); } } });
  assert.equal((await cache.getTruthBundle(input, fixture)).source, 'generated'); assert.equal(cache.stats().cacheReadErrors, 2);
  const invalidBuild = createTruthCache({ persistent: null, packaged: null });
  await assert.rejects(invalidBuild.getTruthBundle(input, () => ({})), /invalid or incomplete/);
  await assert.rejects(invalidBuild.getTruthBundle(input, () => { throw new Error('physical generation failed'); }), /physical generation failed/);
});

test('Node persistence survives a new adapter, preserves double precision and ignores unrelated files', async t => {
  const directory = await temporary(t), store = await createNodeStore({ directory });
  const bundle = fixture(); await store.put(bundle.key, bundle);
  await writeFile(join(directory, 'user-notes.txt'), 'leave me');
  const reopened = await createNodeStore({ directory });
  const loaded = await reopened.get(bundle.key, input);
  assert.deepEqual(loaded, bundle); assert.equal(loaded.truth[0].configs[0].diffuse[0].s[0], Math.PI);
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
  assert.equal(await readFile(join(directory, 'user-notes.txt'), 'utf8'), 'leave me');
});

test('Node persistence evicts bounded owned entries and recovers from corrupt gzip', async t => {
  const directory = await temporary(t), store = await createNodeStore({ directory, maxEntries: 2 });
  for (const seed of [1, 2, 3]) {
    const bundle = fixture({ ...input, seed }); await store.put(bundle.key, bundle);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await readdir(directory)).length, 2);
  assert.equal(await store.get(truthCacheKey(input), input), null);
  for (const file of await readdir(directory)) await writeFile(join(directory, file), 'truncated');
  assert.equal(await store.get(truthCacheKey({ ...input, seed: 3 }), { ...input, seed: 3 }), null);
});

test('packaged manifest selects the smallest adequate vehicle/time capacity and checks gzip hash', async t => {
  const directory = await temporary(t), key = truthCacheKey(input), entries = [];
  for (const [vehicles, snapshots] of [[10, 120], [3, 120], [2, 120], [2, 3]]) {
    const bundle = fixture({ ...input, vehicles, snapshots }), file = `${vehicles}-${snapshots}.json.gz`;
    const bytes = gzipSync(JSON.stringify(bundle)); await writeFile(join(directory, file), bytes);
    entries.push({ key, vehicles, snapshots, file, sha256: checksum(bytes) });
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ entries }));
  const store = createPackagedStore({ manifestUrl: pathToFileURL(join(directory, 'manifest.json')) });
  const small = await store.get(key, input); assert.equal(small.vehicles, 2); assert.equal(small.snapshots, 3);
  const three = await store.get(key, { ...input, vehicles: 3 }); assert.equal(three.vehicles, 3);
  assert.equal(await store.get(truthCacheKey({ ...input, seed: 2 }), { ...input, seed: 2 }), null);
  await writeFile(join(directory, '2-3.json.gz'), gzipSync(JSON.stringify({ ...small, schema: 'tampered' })));
  await assert.rejects(store.get(key, input), /checksum mismatch/);
});

test('packaged malformed capacities and paths cannot become valid cache hits', async () => {
  const bundle = fixture(), bytes = gzipSync(JSON.stringify(bundle));
  for (const entry of [
    { key: bundle.key, file: '../outside.json.gz', vehicles: 2, snapshots: 2 },
    { key: bundle.key, file: 'same.json.gz', vehicles: 3, snapshots: 2 },
  ]) {
    const store = createPackagedStore({ manifestUrl: 'https://example.test/assets/truth-cache/manifest.json',
      readBytes: url => url.pathname.endsWith('manifest.json') ? Buffer.from(JSON.stringify({ entries: [entry] })) : bytes });
    await assert.rejects(store.get(bundle.key, input), /outside its directory|capacity does not match/);
  }
});
