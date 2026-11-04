import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { createGrid, createField } from '../../drf/field.mjs';
import { PSPT } from '../../drf/pspt.mjs';
import { generateScenario } from '../../drf/scenario.mjs';

const root = new URL('../../', import.meta.url), read = path => readFileSync(new URL(path, root));
const artifact = read('drf/offline.bundle.js').toString(), marker = '// Bundled app follows.\n';

test('actual HTML selects the classic local bundle for file and modules for HTTP', () => {
  const html = read('drf.html').toString();
  const bootstrap = html.match(/<script>\s*(const runtime\s*=\s*document\.createElement\('script'\);[\s\S]*?)<\/script>/)?.[1];
  assert.ok(bootstrap, 'Actual protocol bootstrap exists');
  assert.ok(!/disable-web-security|allow-file-access-from-files/.test(bootstrap));
  for (const protocol of ['file:', 'http:', 'https:']) {
    const scripts = [], status = {};
    vm.runInNewContext(bootstrap, { location: { protocol }, document: {
      createElement: tag => { assert.equal(tag, 'script'); return {}; },
      body: { append: script => scripts.push(script) }, getElementById: () => status,
    } });
    assert.equal(scripts.length, 1);
    assert.match(scripts[0].src, protocol === 'file:' ? /^drf\/offline\.bundle\.js\?/ : /^drf\/app\.mjs\?/);
    assert.equal(scripts[0].type, protocol === 'file:' ? undefined : 'module');
    scripts[0].onerror(); assert.match(status.textContent, /Could not load/);
  }
});

test('offline bundle is current and its classic Blob workers preserve the field', async () => {
  const split = artifact.indexOf(marker); assert.ok(split > 0);
  const blobs = new Map(), revoked = [], events = new Map();
  class BlobURL extends URL {
    static createObjectURL(blob) { const url = `blob:test-${blobs.size}`; blobs.set(url, blob); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const context = vm.createContext({ URL: BlobURL, Blob, document: { baseURI: 'file:///lab/drf.html' },
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    Worker: class { constructor(url, options) { this.url = url; this.options = options; } },
  });
  vm.runInContext(artifact.slice(0, split), context);
  const runtime = context.__drfOffline;
  for (const path of ['drf/app.mjs', 'drf/render.mjs', 'drf/field.worker.mjs', 'drf/sweep.mjs', 'drf/pspt.mjs', 'drf/pspt.worker.mjs', 'drf/pspt-math.mjs', 'drf/pspt-ridges.mjs', 'build-drf-offline.mjs'])
    assert.ok(runtime.sourceHashes[path], `Recorded source: ${path}`);
  for (const [path, hash] of Object.entries(runtime.sourceHashes))
    assert.equal(createHash('sha256').update(read(path)).digest('hex'), hash, `${path}: run npm run build:drf-offline`);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.metadata)),
    ['drf/provenance.json', 'drf/reference/octave/fixtures.json'].map(path => JSON.parse(read(path))));
  assert.throws(() => runtime.worker('unknown'), /Unknown DRF worker/);
  for (const name of ['scenario', 'field', 'eval', 'sweep', 'pspt', 'compare', 'run']) {
    const worker = runtime.worker(name);
    assert.equal(worker.options, undefined, 'Blob workers must use the classic script transport');
    assert.equal(runtime.worker(name).url, worker.url, 'Each worker type reuses one Blob URL');
    const source = await blobs.get(worker.url).text();
    assert.ok(!source.includes('import.meta'), `${name}: no module metadata dependency`);
    assert.doesNotThrow(() => new vm.Script(source), `${name}: parses as a classic script`);
  }
  assert.equal(blobs.size, 7);
  const messages = [], workerContext = vm.createContext({ performance, postMessage: data => messages.push(data) });
  workerContext.self = workerContext;
  vm.runInContext(await blobs.get(runtime.worker('field').url).text(), workerContext);
  const grid = createGrid(19, 13), numerical = { band: 4, perimeter: 'exact' };
  const snapshot = { t: 1, configs: [{ i: 0, j: 1, pHat_i: [10, 12], pHat_j: [16, 13],
    Sigma_i: [.01, 0, .01], Sigma_j: [.01, 0, .01], paths: [{ dHat: 14, sigmaD: .1 }] }] };
  workerContext.onmessage({ data: { type: 'init', requestId: 1, grid, numerical } });
  workerContext.onmessage({ data: { type: 'step', requestId: 2, snapshot } });
  const actual = messages.at(-1), expected = createField(grid, numerical).step(snapshot);
  assert.equal(actual.type, 'frame'); assert.equal(actual.Q, expected.Q);
  assert.deepEqual(Array.from(actual.Dbar), Array.from(expected.Dbar));
  assert.deepEqual(Array.from(actual.betaHat), Array.from(expected.betaHat));
  const scenarioMessages = [], scenarioContext = vm.createContext({ performance, setTimeout,
    TextEncoder, TextDecoder, structuredClone, URL,
    postMessage: data => scenarioMessages.push(data) });
  scenarioContext.self = scenarioContext;
  vm.runInContext(await blobs.get(runtime.worker('scenario').url).text(), scenarioContext);
  const input = { scene: 'layered', snapshots: 2, roughness: 20, seed: 42 };
  await scenarioContext.onmessage({ data: { type: 'generate', requestId: 3, input } });
  const offline = scenarioMessages.at(-1), module = await generateScenario(input);
  assert.equal(offline.type, 'scenario');
  // Timings are transport-dependent; numerical truth and whitelist wire must match.
  assert.equal(JSON.stringify(offline.scenario.truth), JSON.stringify(module.truth));
  assert.equal(JSON.stringify(offline.scenario.wire), JSON.stringify(module.wire));
  assert.equal(JSON.stringify(offline.scenario.wallModel), JSON.stringify(module.wallModel));
  assert.equal(JSON.stringify(offline.scenario.wallGeneration), JSON.stringify(module.wallGeneration));
  assert.equal(JSON.stringify(offline.scenario.domain), JSON.stringify([0, 80, -20, 50]));
  // A classic file worker cannot fetch the packaged HTTP bank. Missing browser
  // storage/transport must fall back to identical generation for bank seeds too.
  const cachedSeedInput = { seed: 1, vehicles: 2, snapshots: 2 };
  await scenarioContext.onmessage({ data: { type: 'generate', requestId: 31, input: cachedSeedInput } });
  const fallback = scenarioMessages.at(-1), uncached = await generateScenario(cachedSeedInput);
  assert.equal(fallback.type, 'scenario', fallback.message);
  assert.equal(JSON.stringify(fallback.scenario.truth), JSON.stringify(uncached.truth));
  assert.equal(JSON.stringify(fallback.scenario.wire), JSON.stringify(uncached.wire));
  const psptMessages = [], psptContext = vm.createContext({ performance, postMessage: data => psptMessages.push(data) });
  psptContext.self = psptContext;
  vm.runInContext(await blobs.get(runtime.worker('pspt').url).text(), psptContext);
  psptContext.onmessage({ data: { type: 'init', requestId: 4 } });
  const model = new PSPT();
  for (const wire of module.wire) {
    psptContext.incoming = JSON.stringify({ type: 'step', requestId: 5, snapshot: wire });
    vm.runInContext('onmessage({data: JSON.parse(incoming)})', psptContext);
    const result = psptMessages.at(-1);
    assert.equal(result.type, 'candidates', result.message);
    assert.equal(JSON.stringify(result.candidates), JSON.stringify(model.step(wire)), 'Offline and module PSPT decisions match');
  }
  psptContext.onmessage({ data: { type: 'init', requestId: 6, wallSide: 'upper' } });
  assert.equal(psptMessages.at(-1).type, 'error', 'Worker rejects truth-side options');
  events.get('beforeunload')(); assert.deepEqual(revoked.sort(), [...blobs.keys()].sort());
});
