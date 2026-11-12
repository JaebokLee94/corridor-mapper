#!/usr/bin/env node
/** Precompute simulator-only physical paths. No estimator, noisy measurement or
 * metric is stored. One Vmax realization is generated per seed/roughness pair;
 * smaller fleets retain canonical (i,j) pairs and the same time prefix.
 * Work is O(seeds * roughness * T * Vmax^2 * physical path generation).
 * Memory holds one full raw realization plus one gzip/JSON round-trip at a time.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, open } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeInput, createSceneGeometry, generateTruthSnapshot } from '../drf/scenario.mjs';
import { TRUTH_CACHE_SCHEMA, TRUTH_CACHE_GENERATOR, truthCacheKey, validateTruthBundle } from '../drf/truth-cache.mjs';

const zip = promisify(gzip), unzip = promisify(gunzip);
const REPOSITORY = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const defaults = () => ({ seeds: Array.from({ length: 10 }, (_, i) => i + 1), roughness: [0, 2, 5, 10],
  scene:'layered', vehicles: [2, 3, 5, 10], snapshots: 120, output: resolve(REPOSITORY, 'assets/truth-cache') });

function numbers(value, name) {
  const values = String(value).split(',').map(x => Number(x.trim()));
  if (!values.length || values.some(x => !Number.isFinite(x)) || new Set(values).size !== values.length)
    throw new Error(`${name}: use distinct comma-separated numbers`);
  return values.sort((a, b) => a - b);
}
function validateOptions(options) {
  if (!['layered','paper-upper'].includes(options.scene)) throw new Error('Unsupported bank scene');
  if (!Array.isArray(options.seeds) || !options.seeds.length || options.seeds.some(x => !Number.isInteger(x) || x < 1 || x > 10))
    throw new Error('Seeds must be integers from 1 to 10');
  if (!Array.isArray(options.vehicles) || !options.vehicles.length || options.vehicles.some(x => !Number.isInteger(x) || x < 2 || x > 10))
    throw new Error('Vehicles must be integers from 2 to 10');
  if (!Array.isArray(options.roughness) || !options.roughness.length || options.roughness.some(x => !Number.isFinite(x) || x < 0 || x > 20))
    throw new Error('Roughness must be within 0–20 degrees');
  if (!Number.isInteger(options.snapshots) || options.snapshots < 1 || options.snapshots > 120)
    throw new Error('Snapshots must be an integer from 1 to 120');
  for (const key of ['seeds', 'vehicles', 'roughness']) if (new Set(options[key]).size !== options[key].length)
    throw new Error(`${key}: duplicate values are not allowed`);
  return options;
}

export function parseTruthBankArgs(args) {
  const options = defaults();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--help') return { help: true };
    if (!['--seeds', '--roughness', '--vehicles', '--snapshots', '--scene', '--output'].includes(name) || args[i + 1] == null)
      throw new Error(`Unknown or incomplete option: ${name}`);
    const value = args[++i], key = name.slice(2);
    options[key] = key === 'scene' ? value : key === 'output' ? resolve(value) : key === 'snapshots' ? Number(value) : numbers(value, key);
  }
  return validateOptions(options);
}

/** Hash actual relative static-import dependencies, stripping URL query versions.
 * Provenance includes the physical generator and the schema/key implementation.
 * No estimator/evaluation module is a dependency of the raw truth bank.
 */
export async function truthBankSourceHashes(root = REPOSITORY) {
  const hashes = {}, pending = ['drf/scenario.mjs', 'drf/truth-cache.mjs'];
  while (pending.length) {
    const name = pending.pop();
    if (Object.hasOwn(hashes, name)) continue;
    const location = resolve(root, name), bytes = await readFile(location);
    hashes[name] = sha256(bytes);
    const source = bytes.toString('utf8');
    const imports = /(?:\bimport\s+(?:[^'";]+?\s+from\s+)?|\bexport\s+[^'";]+?\s+from\s+)['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(imports)) {
      if (!match[1].startsWith('.')) continue;
      const dependency = relative(root, resolve(dirname(location), match[1].split(/[?#]/)[0])).split(sep).join('/');
      if (dependency.startsWith('../')) throw new Error(`Source dependency leaves repository: ${dependency}`);
      pending.push(dependency);
    }
  }
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function withManifestLock(directory, operation) {
  const path = resolve(directory, '.manifest.lock'), deadline = Date.now() + 30000;
  let lock;
  while (!lock) {
    try { lock = await open(path, 'wx'); }
    catch (error) { if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error; await delay(50); }
  }
  try { return await operation(); }
  finally { await lock.close(); await unlink(path); }
}

async function recordEntries(output, sourceHashes, entries, assets) {
  return withManifestLock(output, async () => {
    const path = resolve(output, 'manifest.json');
    let previous;
    try { previous = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      assert.equal(previous.schema, TRUTH_CACHE_SCHEMA, 'Existing manifest schema differs');
      assert.equal(previous.generator, TRUTH_CACHE_GENERATOR, 'Existing generator revision differs');
      assert.deepEqual(previous.sourceHashes, sourceHashes, 'Source changed; generate into a fresh output directory');
      assert.ok(Array.isArray(previous.entries), 'Existing manifest entries are invalid');
    }
    // Validate provenance under the same lock before touching named assets. A
    // stale builder must not replace files referenced by a valid older bank.
    for (const asset of assets) await atomicWrite(resolve(output, asset.file), asset.bytes);
    const merged = new Map((previous?.entries ?? []).map(entry => [`${entry.key}|${entry.vehicles}|${entry.snapshots}`, entry]));
    for (const entry of entries) merged.set(`${entry.key}|${entry.vehicles}|${entry.snapshots}`, entry);
    const manifest = { schema: TRUTH_CACHE_SCHEMA, generator: TRUTH_CACHE_GENERATOR, sourceHashes,
      entries: [...merged.values()].sort((a, b) => a.key.localeCompare(b.key) || a.vehicles - b.vehicles || a.snapshots - b.snapshots) };
    await atomicWrite(path, JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  });
}

/** Output is gzip(JSON) with Number precision preserved. Direct deep comparison
 * rejects lost undefined/nonfinite/-0 values rather than silently rounding them.
 * Atomic manifest merging permits two independent builder processes to work on
 * disjoint seed subsets; generation itself remains sequential within a process.
 */
export async function buildTruthBank(request = {}, { onProgress = () => {} } = {}) {
  const options = validateOptions({ ...defaults(), ...request }), output = resolve(options.output);
  const sourceHashes = await truthBankSourceHashes(), started = performance.now(), records = [];
  const maximumVehicles = Math.max(...options.vehicles);
  await mkdir(output, { recursive: true });
  for (const seed of options.seeds) for (const roughness of options.roughness) {
    const start = performance.now(), input = normalizeInput({ scene:options.scene, seed, roughness, vehicles: maximumVehicles, snapshots: options.snapshots });
    const remote=process.env.ECHOMAP_BUILD_DGX_URL;
    const {geometry,truth}=remote ? await (await import('./dgx/client.mjs')).remoteScenario(input,remote,()=>{},true) : {geometry:createSceneGeometry(input),truth:[]};
    for (let t = 1; !remote && t <= input.snapshots; t++) {
      truth.push(generateTruthSnapshot(input, geometry.spans, t, geometry.wallModel));
      onProgress({ phase: 'generate', seed, roughness, vehicles: maximumVehicles, snapshot: t, snapshots: input.snapshots });
      // Yield between snapshots without requiring a browser or altering RNG.
      await new Promise(resolveTask => setImmediate(resolveTask));
    }
    const generationMs = performance.now() - start, entries = [], sizes = [], assets = [];
    assert.deepEqual(await truthBankSourceHashes(), sourceHashes, 'Generator source changed during physical generation');
    for (const vehicles of options.vehicles.slice().sort((a, b) => a - b)) {
      const selected = normalizeInput({ ...input, vehicles }), key = truthCacheKey(selected);
      const bundle = { schema: TRUTH_CACHE_SCHEMA, key, vehicles, snapshots: input.snapshots, geometry,
        truth: truth.map(snapshot => ({ ...snapshot, p: snapshot.p.slice(0, vehicles),
          configs: snapshot.configs.filter(config => config.i <= vehicles && config.j <= vehicles) })) };
      assert.ok(validateTruthBundle(bundle, selected, key), 'Generated bank does not satisfy its raw truth schema');
      const json = JSON.stringify(bundle), bytes = await zip(json, { level: 6 });
      const restored = JSON.parse((await unzip(bytes)).toString('utf8'));
      assert.deepEqual(restored, bundle, 'gzip JSON round trip changed physical truth values');
      const file = `${sha256(key)}.v${vehicles}.t${input.snapshots}.json.gz`;
      assets.push({ file, bytes });
      entries.push({ key, file, sha256: sha256(bytes), ...(remote?{backend:'dgx-h200'}:{}), vehicles, snapshots: input.snapshots });
      sizes.push({ vehicles, rawBytes: Buffer.byteLength(json), gzipBytes: bytes.length });
    }
    assert.deepEqual(await truthBankSourceHashes(), sourceHashes, 'Generator source changed before manifest publication');
    await recordEntries(output, sourceHashes, entries, assets);
    const record = { seed, roughness, generationMs, totalMs: performance.now() - start, sizes,
      rssBytes: process.memoryUsage().rss, maxRssBytes: process.resourceUsage().maxRSS * 1024 };
    records.push(record); onProgress({ phase: 'complete', ...record });
  }
  return { output, entries: records.reduce((n, record) => n + record.sizes.length, 0), elapsedMs: performance.now() - started, records };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseTruthBankArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node tools/build-truth-bank.mjs [--seeds 1,2,...,10] [--roughness 0,2,5,10] [--vehicles 2,3,5,10] [--snapshots 120] [--output directory]\nDefault: 40 physical realizations, each reused for four fleet capacities.');
    else {
      const result = await buildTruthBank(options, { onProgress: event => {
        if (event.phase === 'complete') console.log(JSON.stringify(event));
        else if (event.snapshot === 1 || event.snapshot % 20 === 0 || event.snapshot === event.snapshots)
          console.error(`seed ${event.seed}, roughness ${event.roughness}: ${event.snapshot}/${event.snapshots}`);
      } });
      console.log(JSON.stringify({ phase: 'done', ...result }));
    }
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
