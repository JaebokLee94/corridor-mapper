import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { buildTruthBank, parseTruthBankArgs, truthBankSourceHashes } from '../../tools/build-truth-bank.mjs';
import { normalizeInput, createSceneGeometry, generateTruthSnapshot, generateSnapshot, measureTruthSnapshot } from '../../drf/scenario.mjs';
import { TRUTH_CACHE_SCHEMA, TRUTH_CACHE_GENERATOR, truthCacheKey, createPackagedStore, validateTruthBundle } from '../../drf/truth-cache.mjs';

const unzip = promisify(gunzip), digest = bytes => createHash('sha256').update(bytes).digest('hex');
let directory, manifest, built;
test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'echomap-truth-bank-test-'));
  built = await buildTruthBank({ output: directory, seeds: [1], roughness: [0], vehicles: [2, 3, 5], snapshots: 2 });
  manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
});
test.after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('bank CLI defaults cover seeds 1–10 and supported fleet capacities; invalid limits fail', () => {
  const defaults = parseTruthBankArgs([]);
  assert.deepEqual(defaults.seeds, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(defaults.roughness, [0, 2, 5, 10]); assert.deepEqual(defaults.vehicles, [2, 3, 5, 10]);
  assert.equal(defaults.snapshots, 120);
  assert.deepEqual(parseTruthBankArgs(['--seeds', '10,1', '--vehicles', '5,2']).seeds, [1, 10]);
  for (const args of [['--seeds', '11'], ['--seeds', '1,1'], ['--vehicles', '11'], ['--roughness', '-1'], ['--snapshots', '0'], ['--snapshots', '121'], ['--unknown', 'x']])
    assert.throws(() => parseTruthBankArgs(args));
});

test('manifest fingerprints actual generator imports and every compressed asset', async () => {
  assert.equal(manifest.schema, TRUTH_CACHE_SCHEMA); assert.equal(manifest.generator, TRUTH_CACHE_GENERATOR);
  assert.equal(built.entries, 3); assert.equal(manifest.entries.length, 3);
  assert.deepEqual(manifest.sourceHashes, await truthBankSourceHashes());
  for (const dependency of ['scenario', 'wall', 'specular', 'diffuse', 'rng', 'poly', 'wire', 'truth-cache']) {
    const name = `drf/${dependency}.mjs`, bytes = await readFile(new URL(`../../${name}`, import.meta.url));
    assert.equal(manifest.sourceHashes[name], digest(bytes), name);
  }
  assert.ok(!Object.keys(manifest.sourceHashes).some(name => /pspt|comparison|evaluate/.test(name)));
  for (const entry of manifest.entries) {
    const bytes = await readFile(join(directory, entry.file));
    assert.equal(entry.sha256, digest(bytes));
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
    const bundle = JSON.parse((await unzip(bytes)).toString('utf8'));
    const input = normalizeInput({ seed: 1, roughness: 0, vehicles: entry.vehicles, snapshots: 2 });
    assert.equal(entry.key, truthCacheKey(input)); assert.equal(bundle.schema, TRUTH_CACHE_SCHEMA);
    assert.equal(bundle.key, entry.key); assert.equal(bundle.vehicles, entry.vehicles); assert.equal(bundle.snapshots, 2);
    assert.ok(validateTruthBundle(bundle, input));
    assert.ok(!Object.hasOwn(bundle, 'wire')); assert.ok(!Object.hasOwn(bundle, 'evaluation'));
    for (const snapshot of bundle.truth) for (const config of snapshot.configs) for (const point of [...config.specular, ...config.diffuse]) {
      assert.ok(!Object.hasOwn(point, 'z')); assert.ok(!Object.hasOwn(point, 'dHat'));
    }
  }
});

test('derived vehicle pairs and gzip JSON preserve independently generated raw truth and measurements exactly', async () => {
  const store = createPackagedStore({ manifestUrl: pathToFileURL(join(directory, 'manifest.json')) });
  for (const vehicles of [2, 3, 5]) {
    const input = normalizeInput({ seed: 1, roughness: 0, vehicles, snapshots: 2 });
    const geometry = createSceneGeometry(input), bundle = await store.get(truthCacheKey(input), input);
    assert.deepEqual(bundle.geometry, geometry);
    for (let t = 1; t <= input.snapshots; t++) {
      const raw = generateTruthSnapshot(input, geometry.spans, t, geometry.wallModel);
      assert.deepEqual(bundle.truth[t - 1], raw, `exact physical truth for V=${vehicles}, t=${t}`);
      for (const observation of [{ sigmaD: .3, sigmaP: .2 }, { specular: false }, { resolution: .2 }]) {
        const changed = normalizeInput({ ...input, ...observation });
        assert.deepEqual(measureTruthSnapshot(changed, bundle.truth[t - 1]), generateSnapshot(changed, geometry.spans, t, geometry.wallModel));
      }
    }
  }
});

test('disjoint builder runs merge their manifest entries instead of erasing previous seeds', async () => {
  const extra = await buildTruthBank({ output: directory, seeds: [2], roughness: [0], vehicles: [2], snapshots: 1 });
  const updated = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(extra.entries, 1); assert.equal(updated.entries.length, 4);
  for (const entry of manifest.entries) assert.deepEqual(updated.entries.find(item => item.file === entry.file), entry);
});

test('concurrent independent bank writers retain both completed conditions', async () => {
  const output = await mkdtemp(join(tmpdir(), 'echomap-truth-bank-parallel-'));
  try {
    await Promise.all([8, 9].map(seed => buildTruthBank({ output, seeds: [seed], roughness: [0], vehicles: [2], snapshots: 1 })));
    const concurrent = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.deepEqual(concurrent.entries.map(entry => JSON.parse(entry.key).seed).sort(), [8, 9]);
    for (const entry of concurrent.entries) assert.equal(digest(await readFile(join(output, entry.file))), entry.sha256);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('source provenance mismatch refuses to publish a mixed-generation manifest', async () => {
  const output = await mkdtemp(join(tmpdir(), 'echomap-truth-bank-stale-'));
  try {
    const stale = { ...manifest, sourceHashes: { ...manifest.sourceHashes, 'drf/rng.mjs': '0'.repeat(64) } };
    const previous = JSON.stringify(stale);
    await writeFile(join(output, 'manifest.json'), previous);
    await assert.rejects(buildTruthBank({ output, seeds: [1], roughness: [0], vehicles: [2], snapshots: 1 }), /Source changed/);
    assert.equal(await readFile(join(output, 'manifest.json'), 'utf8'), previous);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('packaged default bank covers all 40 physical settings and the straight-route examples with current source hashes and intact gzip bytes', async () => {
  const location = new URL('../../assets/truth-cache/manifest.json', import.meta.url);
  const packaged = JSON.parse(await readFile(location, 'utf8'));
  assert.equal(packaged.schema, TRUTH_CACHE_SCHEMA); assert.equal(packaged.generator, TRUTH_CACHE_GENERATOR);
  assert.deepEqual(packaged.sourceHashes, await truthBankSourceHashes(), 'Packaged truth must be regenerated after a numerical dependency changes');
  const expected = new Set();
  for (let seed = 1; seed <= 10; seed++) for (const roughness of [0, 2, 5, 10]) for (const vehicles of [2, 3, 5, 10]) {
    const input = normalizeInput({ seed, roughness, vehicles, snapshots: 120 });
    expected.add(`${truthCacheKey(input)}|${vehicles}|120`);
  }
  for (let seed=1;seed<=10;seed++) for (const vehicles of [3,10]) {
    const input=normalizeInput({scene:'paper-upper',seed,vehicles});
    expected.add(`${truthCacheKey(input)}|${vehicles}|100`);
  }
  assert.equal(packaged.entries.length, expected.size);
  assert.equal(new Set(packaged.entries.map(entry => entry.file)).size, expected.size);
  for (const entry of packaged.entries) {
    assert.ok(expected.delete(`${entry.key}|${entry.vehicles}|${entry.snapshots}`), 'No extra or duplicate physical setting/capacity');
    assert.ok(/^[a-f0-9]{64}\.v\d+\.t(?:100|120)\.json\.gz$/.test(entry.file));
    const bytes = await readFile(new URL(entry.file, location));
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
    assert.equal(digest(bytes), entry.sha256, entry.file);
  }
  assert.equal(expected.size, 0, 'Every requested seed/roughness/fleet capacity is present');
});
