import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import http from 'node:http';
import { createSimulationServer } from '../../tools/simulation-server.mjs';
import { encodePacket, decodePacket, createMessageEncoder, createMessageDecoder } from '../../drf/simulation-codec.mjs';
import { createRunEngine } from '../../drf/run-engine.mjs';

const input = { scene: 'reference', vehicles: 2, snapshots: 3, grid: 100,
  roughness: 0, specular: false, lambda0: 0, cellStep: .2, seed: 42, sigmaP: .1, sigmaD: .1 };
const post = (base, path, value) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
async function ready(t, options) {
  const service = await createSimulationServer(options), base = await service.listen(0);
  t.after(() => service.close()); return { ...service, base };
}
async function waitFor(base, job, condition) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const response = await fetch(base + job.statusUrl), state = await response.json();
    assert.equal(response.status, 200, state.error);
    if (condition(state)) return state;
    if (state.status === 'failed') assert.fail(state.error);
    await delay(10);
  }
  assert.fail('Simulation did not reach the expected state');
}
async function readMessages(base, job, count) {
  const codec = createMessageDecoder(), messages = [];
  for (let seq = 1; seq <= count; seq++) messages.push(codec.decode(await (await fetch(`${base}${job.messagesUrl}/${seq}`)).arrayBuffer()));
  return messages;
}

test('binary transport preserves typed-array bits and nonfinite metrics', () => {
  const values = new Float32Array([0, -0, 1 / 3, Infinity, -Infinity, NaN]);
  const result = decodePacket(encodePacket({ values, other: new Float64Array([Math.PI]), missing: null, bad: NaN }));
  assert.deepEqual(new Uint8Array(result.values.buffer), new Uint8Array(values.buffer));
  assert.equal(result.other[0], Math.PI); assert.equal(result.missing, null); assert.ok(Number.isNaN(result.bad));
  assert.throws(() => decodePacket(new Uint8Array([255, 0, 0, 0])), /Truncated/);
});

test('diagnostic deltas retain causal history without repeating earlier arrays', () => {
  const encoder = createMessageEncoder(), decoder = createMessageDecoder();
  function frame(ratios, t) {
    const diagnostics = { ratios, diffuseCounts: Array.from({ length: t }, (_, i) => i), predictedCounts: Array(t).fill(1), theoremMean: .5 },
      guarded = { diagnostics, precision: null }, baseline = { diagnostics, precision: 1 };
    return { type: 'frame', next: t, frame: { t, Dbar: new Float32Array([1, 2]),
      candidates: [{ id: 1 }], methods: { guarded: { candidates: [{ id: 1 }] }, baseline: { candidates: [] } } },
      evaluation: { ...guarded, methods: { guarded, baseline } } };
  }
  const first = decoder.decode(encoder.encode(frame([1, 2], 1)));
  const packed = encoder.encode(frame([1, 2, 3], 2)), raw = decodePacket(packed);
  assert.deepEqual(Array.from(raw.$evaluation.samples.ratios.values), [3]);
  assert.equal(raw.$evaluation.samples.ratios.base, 2);
  const second = decoder.decode(packed);
  assert.deepEqual(Array.from(first.evaluation.diagnostics.ratios), [1, 2]);
  assert.deepEqual(second.evaluation.diagnostics.ratios.filter(x => x > 1), [2, 3]);
  assert.equal(JSON.stringify(first.evaluation.diagnostics.ratios), '[1,2]');
  assert.equal(first.frame.candidates, first.frame.methods.guarded.candidates);
  assert.equal(first.evaluation.diagnostics, first.evaluation.methods.baseline.diagnostics);
  assert.throws(() => { first.evaluation.diagnostics.ratios.push(4); }, /read-only/);
  assert.throws(() => decoder.decode(packed), /out-of-order/);
});

test('local service rejects foreign origins, DNS rebinding, non-JSON and private paths', async t => {
  const { base } = await ready(t);
  assert.equal((await (await fetch(base + '/api/health')).json()).schema, 'echomap-server/1');
  const hostileHost = await new Promise((resolve, reject) => {
    http.get(base + '/api/health', { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostileHost, 403);
  assert.equal((await fetch(base + '/api/health', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/jobs', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/.git/config')).status, 404);
  assert.equal((await post(base, '/api/jobs', { input: { sigmaD: 0 } })).status, 400);
  assert.equal((await post(base, '/api/jobs', { mode: 'sweep', jobs: [] })).status, 400);
});

test('cross-site top-level viewer entry works without opening API or iframe access', async t => {
  const { base } = await ready(t);
  const status = (path, headers) => new Promise((resolve, reject) => {
    http.get(base + path, { headers }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  assert.equal(await status('/drf.html', navigation), 200);
  assert.equal(await status('/', navigation), 200);
  assert.equal(await status('/api/health', navigation), 403);
  assert.equal(await status('/api/jobs', navigation), 403);
  assert.equal(await status('/drf.html', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }), 403);
  assert.equal(await status('/drf.html', { ...navigation, 'Sec-Fetch-Mode': 'cors' }), 403);
  assert.equal(await status('/drf.html', { ...navigation, Host: 'attacker.example' }), 403);
  assert.equal(await status('/drf.html', { ...navigation, Origin: 'https://attacker.example' }), 403);
});

test('job finishes without any browser/event consumer; late reconnect recovers identical frames', async t => {
  const { base } = await ready(t), response = await post(base, '/api/jobs', { input });
  assert.equal(response.status, 201); const job = await response.json();
  // No event stream exists while this actual Node worker computes.
  const state = await waitFor(base, job, value => value.status === 'done');
  const messages = await readMessages(base, job, state.seq), frames = messages.filter(value => value.type === 'frame');
  assert.deepEqual(frames.map(value => value.next), [1, 2, 3]);
  const expected = [];
  await createRunEngine({ emit: message => { if (message.type === 'frame') expected.push(message); } }).command({ type: 'start', input, requestId: 1 });
  for (let i = 0; i < frames.length; i++) {
    assert.deepEqual(frames[i].frame.Dbar, expected[i].frame.Dbar);
    assert.deepEqual(frames[i].frame.betaHat, expected[i].frame.betaHat);
    assert.equal(frames[i].evaluation.recall, expected[i].evaluation.recall);
  }
  const abort = new AbortController(), stream = await fetch(`${base}${job.eventsUrl}?after=${state.seq - 1}`, { signal: abort.signal });
  const reader = stream.body.getReader(), first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, new RegExp(`id: ${state.seq}`)); assert.match(first, /event: notice/); abort.abort();
});

test('single-step, one active job, explicit cancellation and next job are independent of connection lifetime', async t => {
  const { base } = await ready(t), job = await (await post(base, '/api/jobs', { input, single: true })).json();
  await waitFor(base, job, state => state.status === 'paused' && state.next === 1);
  assert.equal((await post(base, '/api/jobs', { input })).status, 409);
  await post(base, `${job.statusUrl}/command`, { type: 'step' });
  await waitFor(base, job, state => state.status === 'paused' && state.next === 2);
  await post(base, `${job.statusUrl}/command`, { type: 'cancel' });
  const cancelled = await waitFor(base, job, state => state.status === 'cancelled');
  await post(base, `${job.statusUrl}/command`, { type: 'resume' }); await delay(30);
  assert.equal((await (await fetch(base + job.statusUrl)).json()).seq, cancelled.seq);
  const next = await (await post(base, '/api/jobs', { input })).json();
  await waitFor(base, next, state => state.status === 'done');
});

test('server owns complete sweep dispatch with no browser client and keeps per-seed outputs', async t => {
  const { base } = await ready(t, { sweepWorkers: 2 });
  const job = await (await post(base, '/api/jobs', { mode: 'sweep', jobs: [input, { ...input, seed: 43 }, { ...input, seed: 44 }] })).json();
  const state = await waitFor(base, job, value => value.status === 'done');
  const messages = await readMessages(base, job, state.seq), results = messages.filter(value => value.type === 'sweep-result');
  assert.deepEqual(results.map(value => value.id).sort(), [0, 1, 2]);
  assert.equal(state.next, 3); assert.equal(state.total, 3);
  assert.ok(results.every(value => value.result.methods.guarded && value.result.methods.baseline && !value.result.final));
});

test('simultaneous submissions cannot bypass the single-active-job limit', async t => {
  const { base } = await ready(t);
  const responses = await Promise.all([post(base, '/api/jobs', { input, single: true }), post(base, '/api/jobs', { input, single: true })]);
  assert.deepEqual(responses.map(value => value.status).sort(), [201, 409]);
});

test('result storage ceiling terminates work and reports failure instead of filling disk', async t => {
  const { base } = await ready(t, { maxJobBytes: 1024 });
  const job = await (await post(base, '/api/jobs', { input })).json();
  const state = await waitFor(base, job, value => value.status === 'failed');
  assert.match(state.error, /storage limit/);
  const messages = await readMessages(base, job, state.seq);
  assert.equal(messages.at(-1).type, 'error'); assert.ok(state.bytes < 2048);
});

test('a failed disk write permanently stops queued result publication, including an already queued done', async t => {
  let firstDirectory, rejectWrite;
  const writes = [], blockedWrite = new Promise((_, reject) => { rejectWrite = reject; });
  t.after(() => rejectWrite(new Error('Release injected write barrier during test cleanup')));
  const { base } = await ready(t, { writePacket: async (path, bytes) => {
    writes.push(path);
    if (!firstDirectory) { firstDirectory = dirname(path); return blockedWrite; }
    return writeFile(path, bytes);
  } });
  const first = await (await post(base, '/api/jobs', { input })).json();
  // A new job is admitted only after the first worker has emitted its terminal
  // status. Its first write remains blocked, so all first-job packets, including
  // "done", are now behind the deliberately failing write in the storage queue.
  let second; const deadline = Date.now() + 30000;
  while (!second && Date.now() < deadline) {
    const response = await post(base, '/api/jobs', { input });
    if (response.status === 201) second = await response.json();
    else { assert.equal(response.status, 409); await delay(10); }
  }
  assert.ok(second, 'First worker should finish independently of pending disk I/O');
  rejectWrite(Object.assign(new Error('Injected disk full'), { code: 'ENOSPC' }));
  const failed = await waitFor(base, first, state => state.status === 'failed');
  await waitFor(base, second, state => state.status === 'done');
  const final = await (await fetch(base + first.statusUrl)).json();
  assert.equal(failed.seq, 0); assert.equal(final.status, 'failed'); assert.equal(final.seq, 0);
  assert.match(final.error, /Injected disk full/);
  assert.equal(writes.filter(path => dirname(path) === firstDirectory).length, 1,
    'No already queued packet may be written after the first storage failure');
});

test('completed storage retention is bounded and removed on shutdown', async () => {
  const service = await createSimulationServer({ completedTtlMs: 500 }), base = await service.listen(0);
  try {
    const job = await (await post(base, '/api/jobs', { input: { ...input, snapshots: 1 } })).json();
    await waitFor(base, job, value => value.status === 'done'); await delay(1100);
    assert.deepEqual((await (await fetch(base + '/api/jobs')).json()).jobs, []);
  } finally { await service.close(); }
  await assert.rejects(access(service.storage));
});
