import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeInput, generateScenario } from '../../drf/scenario.mjs';
import { buildTruthBundle, createScenarioPreparer, createTruthWarmer } from '../../drf/prepare-scenario.mjs';
import { createTruthCache, TRUTH_CACHE_SCHEMA, truthCacheKey } from '../../drf/truth-cache.mjs';

const base = { scene: 'reference', seed: 1, vehicles: 3, snapshots: 2,
  grid: 100, cellStep: .2, roughness: 2, sigmaP: .1, sigmaD: .1 };
const withoutTiming = ({ simulatorMs, ...scenario }) => scenario;
function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}
async function physicalFixture(input = base) {
  return { ...await buildTruthBundle(input), schema: TRUTH_CACHE_SCHEMA,
    key: truthCacheKey(normalizeInput(input)) };
}

test('warmup reads immutable physical paths once and creates no observations or generated cache record', async () => {
  const bundle = freezeDeep(await physicalFixture()), before = structuredClone(bundle);
  let reads = 0;
  const cache = createTruthCache({ persistent: null, packaged: { get() { reads++; return bundle; } } });
  const warm = createTruthWarmer({ cache });
  assert.equal(await warm(base), true);
  assert.equal(await warm({ ...base, sigmaP: .2, sigmaD: .3 }), true);
  assert.equal(reads, 1);
  assert.deepEqual(cache.stats(), { memory: 1, persistent: 0, packaged: 1, generated: 0, uncached: 0,
    cacheReadErrors: 0, cacheWriteErrors: 0, invalidEntries: 0, memoryEntries: 1 });
  assert.deepEqual(bundle, before);
  assert.equal(Object.hasOwn(bundle, 'wire'), false);
  for (const frame of bundle.truth) {
    assert.equal(Object.hasOwn(frame, 'poseNoise'), false);
    for (const config of frame.configs) for (const path of [...config.specular, ...config.diffuse]) {
      assert.equal(Object.hasOwn(path, 'z'), false);
      assert.equal(Object.hasOwn(path, 'dHat'), false);
    }
  }
});

test('a warm hit applies current noise and preserves the exact uncached measured scenario', async () => {
  const bundle = freezeDeep(await physicalFixture({ ...base, vehicles: 4, snapshots: 3 }));
  let reads = 0;
  const cache = createTruthCache({ persistent: null, packaged: { get() { reads++; return bundle; } } });
  const warm = createTruthWarmer({ cache }), prepare = createScenarioPreparer({ cache });
  assert.equal(await warm({ ...base, vehicles: 4, snapshots: 3 }), true);
  for (const input of [base, { ...base, vehicles: 2, snapshots: 1, sigmaP: .2, sigmaD: .3 }]) {
    let source;
    const actual = await prepare(input, undefined, { onCache: event => { source = event.source; } });
    assert.equal(source, 'memory');
    assert.deepEqual(withoutTiming(actual), withoutTiming(await generateScenario(input)));
  }
  assert.equal(reads, 1);
  assert.equal(cache.stats().generated, 0);
});

test('a warm miss offers only a refusing builder and never starts physical generation', async () => {
  let lookups = 0, builderCalls = 0;
  const warm = createTruthWarmer({ cache: { async getTruthBundle(input, build) {
    lookups++; assert.equal(input.seed, 1);
    builderCalls++;
    return build();
  } } });
  assert.equal(await warm(base), false);
  assert.equal(lookups, 1); assert.equal(builderCalls, 1);
  // Out-of-bank seeds and fleets must not read, build, or allocate a truth bundle.
  for (const input of [{ ...base, seed: 0 }, { ...base, seed: 11 }, { ...base, vehicles: 11 }])
    assert.equal(await warm(input), false);
  assert.equal(lookups, 1);
});

test('normal preparation after a warm miss regenerates once and matches the uncached reference', async () => {
  const cache = createTruthCache({ persistent: null, packaged: null });
  assert.equal(await createTruthWarmer({ cache })(base), false);
  assert.equal(cache.stats().generated, 0);
  assert.equal(cache.stats().memoryEntries, 0);
  let source;
  const actual = await createScenarioPreparer({ cache })(base, undefined, { onCache: event => { source = event.source; } });
  assert.equal(source, 'generated');
  assert.equal(cache.stats().generated, 1);
  assert.deepEqual(withoutTiming(actual), withoutTiming(await generateScenario(base)));
});

const waitUntil = async (condition, label) => {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, label);
    await delay(5);
  }
};

async function heldWarmWorker(t) {
  const directory = await mkdtemp(join(tmpdir(), 'echomap-warmup-test-'));
  const workerUrl = new URL('../../drf/run.worker.mjs', import.meta.url).href;
  // Hold only this worker's manifest read. An empty bank makes the warm miss
  // deterministic without downloading large assets or touching the user's cache.
  const worker = new Worker(`
    const {parentPort}=require('node:worker_threads');
    const fs=require('node:fs/promises');
    const originalRead=fs.readFile;
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    fs.readFile=async function(path,...args){
      if(String(path).endsWith('/assets/truth-cache/manifest.json')){
        parentPort.postMessage({type:'manifest-blocked'});
        await gate;
        return Buffer.from('{"entries":[]}');
      }
      return originalRead.call(this,path,...args);
    };
    require('node:module').syncBuiltinESMExports();
    globalThis.postMessage=(message,transfer)=>parentPort.postMessage(message,transfer);
    import(${JSON.stringify(workerUrl)}).then(()=>{
      parentPort.on('message',data=>{
        if(data.type==='release-manifest') return release();
        if(data.type==='barrier') return parentPort.postMessage({type:'barrier'});
        void globalThis.onmessage({data});
      });
      parentPort.postMessage({type:'ready'});
    }).catch(error=>{throw error;});
  `, { eval: true, env: { ...process.env, ECHOMAP_TRUTH_CACHE_DIR: directory } });
  t.after(async () => { await worker.terminate(); await rm(directory, { recursive: true, force: true }); });
  const messages = [], failures = [];
  worker.on('message', message => messages.push(message));
  worker.on('error', error => failures.push(error));
  const [ready] = await once(worker, 'message'); assert.equal(ready.type, 'ready');
  worker.postMessage({ type: 'warm-truth', input: base });
  await waitUntil(() => messages.some(message => message.type === 'manifest-blocked'), 'warmup should reach the held manifest read');
  return { worker, messages, failures };
}

test('actual worker Run during a pending warm miss waits for settlement then generates normally', async t => {
  const { worker, messages, failures } = await heldWarmWorker(t);
  worker.postMessage({ type: 'start', requestId: 71, input: base, single: true });
  worker.postMessage({ type: 'barrier' });
  await waitUntil(() => messages.some(message => message.type === 'barrier'), 'worker should stay responsive while warming');
  assert.ok(messages.some(message => message.type === 'preparation' && message.phase === 'loading'));
  assert.ok(!messages.some(message => ['progress', 'prepared', 'frame', 'error'].includes(message.type)));
  worker.postMessage({ type: 'release-manifest' });
  await waitUntil(() => failures.length || messages.some(message => message.type === 'error'
    || (message.type === 'status' && message.mode === 'paused')), 'Run should recover from the pending warm miss');
  assert.deepEqual(failures, []);
  assert.deepEqual(messages.filter(message => message.type === 'error'), []);
  assert.deepEqual(messages.find(message => message.type === 'truth-warmed'), { type: 'truth-warmed', hit: false });
  const prepared = messages.find(message => message.type === 'prepared');
  assert.ok(prepared, 'normal generation must produce a scenario after the warm miss');
  assert.deepEqual(withoutTiming(prepared.scenario), withoutTiming(await generateScenario(base)));
  assert.deepEqual(messages.filter(message => message.type === 'frame').map(message => message.next), [1]);
  assert.equal(messages.at(-1).mode, 'paused');
});

test('cancelling Run while warmup is pending prevents late preparation and permits a fresh Run', async t => {
  const { worker, messages, failures } = await heldWarmWorker(t);
  worker.postMessage({ type: 'start', requestId: 72, input: base });
  worker.postMessage({ type: 'cancel', requestId: 72 });
  await waitUntil(() => messages.some(message => message.type === 'status' && message.mode === 'cancelled'),
    'pending Run must acknowledge cancellation before the cache read completes');
  assert.ok(messages.some(message => message.type === 'preparation' && message.requestId === 72));
  worker.postMessage({ type: 'release-manifest' });
  await waitUntil(() => messages.some(message => message.type === 'truth-warmed'), 'warm miss should settle after cancellation');
  worker.postMessage({ type: 'barrier' });
  await waitUntil(() => messages.some(message => message.type === 'barrier'), 'worker should process the settled start continuation');
  assert.deepEqual(failures, []);
  assert.ok(!messages.some(message => ['progress', 'prepared', 'frame', 'error'].includes(message.type)),
    'a cancelled pending Run must never generate, prepare or compute after the cache read finishes');
  worker.postMessage({ type: 'start', requestId: 73, input: base });
  await waitUntil(() => failures.length || messages.some(message => message.type === 'error'
    || (message.type === 'status' && message.mode === 'done')), 'the same worker should accept a fresh Run');
  assert.deepEqual(failures, []);
  assert.deepEqual(messages.filter(message => message.type === 'error'), []);
  assert.deepEqual(messages.filter(message => message.type === 'frame').map(message => [message.requestId, message.next]),
    [[73, 1], [73, 2]]);
});
