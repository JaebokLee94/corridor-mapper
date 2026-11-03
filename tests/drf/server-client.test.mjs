import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createServerRunWorker, connectComputeServer, startServerSweep } from '../../drf/server-client.mjs';
import { createMessageEncoder, encodePacket } from '../../drf/simulation-codec.mjs';
import { DEFAULT_INPUT } from '../../drf/scenario.mjs';

const savedKey = 'echomap-server-job/1';
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function fixture(t) {
  const descriptors = Object.fromEntries(['fetch', 'EventSource', 'localStorage', 'setTimeout', 'clearTimeout']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const storage = new Map(), calls = [], streams = [], timers = new Map(), packets = new Map();
  let timerId = 0;
  const job = { id: 'job-1', mode: 'comparison', status: 'running', seq: 0 };
  const f = { storage, calls, streams, timers, packets, job, route: null,
    runTimer() { const entry = timers.entries().next().value; assert.ok(entry, 'Expected a pending retry'); timers.delete(entry[0]); entry[1](); },
    commands() { return calls.filter(call => call.url.endsWith('/command')); },
    messageRequests() { return calls.filter(call => call.url.includes('/messages/')).map(call => Number(call.url.split('/').at(-1))); },
  };
  class Events {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); this.closed = false; streams.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    close() { this.closed = true; this.readyState = 2; }
    emit(type, data) {
      if (type === 'open') this.readyState = 1;
      this.listeners.get(type)?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
  }
  Object.assign(globalThis, {
    EventSource: Events,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      const call = { url: String(url), options, body: options.body ? JSON.parse(options.body) : null }; calls.push(call);
      const override = f.route?.(call); if (override !== undefined) return override;
      if (call.url === '/api/health') return jsonResponse({ schema: 'echomap-server/1' });
      if (call.url === '/api/jobs') return options.method === 'POST' ? jsonResponse(job, 201) : jsonResponse({ jobs: [] });
      if (call.url === '/api/jobs/job-1') return jsonResponse(job);
      if (call.url === '/api/jobs/job-1/command') return jsonResponse(job, 202);
      const match = /\/messages\/(\d+)$/.exec(call.url);
      if (match) return packets.has(Number(match[1])) ? new Response(packets.get(Number(match[1]))) : jsonResponse({ error: 'Message unavailable' }, 404);
      throw new Error(`Unexpected mocked request ${call.url}`);
    },
  });
  t.after(() => {
    streams.forEach(stream => stream.close()); timers.clear();
    for (const [key, descriptor] of Object.entries(descriptors)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  f.worker = options => {
    const worker = createServerRunWorker({}, options), messages = [], errors = [];
    worker.onmessage = ({ data }) => messages.push(data); worker.onerror = error => errors.push(error.message);
    t.after(() => worker.detach());
    return { worker, messages, errors };
  };
  return f;
}

function comparisonPackets() {
  const encoder = createMessageEncoder();
  const frame = t => {
    const diagnostics = { ratios: Array.from({ length: t }, (_, i) => i + .5), diffuseCounts: [t], predictedCounts: [t + .5] };
    // Counts are also cumulative in real output.
    diagnostics.diffuseCounts = Array.from({ length: t }, (_, i) => i + 1);
    diagnostics.predictedCounts = Array.from({ length: t }, (_, i) => i + 1.5);
    const methods = { guarded: { diagnostics, recall: t / 2 }, baseline: { diagnostics, recall: t / 3 } };
    return { type: 'frame', next: t, frame: { t, methods: { guarded: { candidates: [] }, baseline: { candidates: [] } } },
      evaluation: { ...methods.guarded, methods } };
  };
  return [
    { type: 'status', mode: 'running', next: 0, total: 2 }, { type: 'prepared', scenario: {}, grid: {} },
    frame(1), frame(2), { type: 'status', mode: 'done', next: 2, total: 2 },
  ].map(message => encoder.encode(message));
}

test('availability notices can skip or repeat sequence numbers while every binary delta is retrieved exactly once in order', async t => {
  const f = fixture(t); comparisonPackets().forEach((packet, i) => f.packets.set(i + 1, packet));
  const { worker, messages, errors } = f.worker();
  worker.postMessage({ type: 'start', requestId: 17, input: { seed: 42 } }); await flush();
  const stream = f.streams[0]; stream.emit('notice', { seq: 5 }); stream.emit('notice', { seq: 3 }); stream.emit('notice', { seq: 5 }); await flush();
  assert.deepEqual(f.messageRequests(), [1, 2, 3, 4, 5]); assert.deepEqual(errors, []);
  const frames = messages.filter(message => message.type === 'frame');
  assert.deepEqual(frames.map(message => message.next), [1, 2]);
  assert.deepEqual(Array.from(frames[0].evaluation.diagnostics.ratios), [.5]);
  assert.deepEqual(Array.from(frames[1].evaluation.diagnostics.ratios), [.5, 1.5]);
  assert.ok(messages.every(message => message.requestId === 17));
  assert.equal(stream.closed, true); assert.equal(f.commands().length, 0);
});

test('detach during creation keeps the job, while explicit terminate cancels a late creation once', async t => {
  const f = fixture(t), creation = deferred();
  f.route = call => call.url === '/api/jobs' && call.options.method === 'POST' ? creation.promise : undefined;
  const first = f.worker(); first.worker.postMessage({ type: 'start', requestId: 1, input: {} }); first.worker.detach();
  creation.resolve(jsonResponse(f.job, 201)); await flush();
  assert.equal(f.commands().length, 0); assert.equal(f.streams.length, 0); assert.equal(f.storage.get(savedKey), f.job.id);
  const later = deferred(); f.route = call => call.url === '/api/jobs' && call.options.method === 'POST' ? later.promise : undefined;
  const second = f.worker(); second.worker.postMessage({ type: 'start', requestId: 2, input: {} });
  second.worker.terminate(); second.worker.terminate();
  later.resolve(jsonResponse(f.job, 201)); await flush();
  assert.deepEqual(f.commands().map(call => call.body), [{ type: 'cancel' }]);
  assert.equal(f.storage.has(savedKey), false); assert.equal(f.streams.length, 0);
});

test('refresh detaches a result stream without cancellation and resumes from persisted ordered history', async t => {
  const f = fixture(t); f.packets.set(1, encodePacket({ type: 'status', mode: 'paused', next: 0, total: 2 }));
  const first = f.worker(); first.worker.postMessage({ type: 'start', requestId: 1, input: {} }); await flush(); first.worker.detach();
  assert.equal(f.commands().length, 0); assert.equal(f.storage.get(savedKey), f.job.id);
  f.job.seq = 1;
  const config = await connectComputeServer(); assert.equal(config.job.id, f.job.id);
  const resumed = f.worker({ resumeId: config.job.id }); resumed.worker.postMessage({ type: 'start', requestId: 8 }); await flush();
  assert.equal(f.calls.filter(call => call.url === '/api/jobs' && call.options.method === 'POST').length, 1);
  assert.equal(resumed.messages.find(message => message.type === 'status').mode, 'paused');
  assert.deepEqual(resumed.errors, []); assert.equal(f.commands().length, 0);
});

test('large sweep creation uses an ordinary request while only small control commands use keepalive', async t => {
  const f = fixture(t), jobs = Array.from({ length: 300 }, (_, i) => ({ ...DEFAULT_INPUT, seed: i + 1 }));
  f.route = call => {
    if (call.options.keepalive && new TextEncoder().encode(call.options.body).byteLength > 65536)
      throw new TypeError('Keepalive body exceeds 64 KiB');
  };
  const { worker, errors } = f.worker({ mode: 'sweep', jobs });
  worker.postMessage({ type: 'start', requestId: 22 }); await flush();
  const creation = f.calls.find(call => call.url === '/api/jobs' && call.options.method === 'POST');
  assert.ok(new TextEncoder().encode(creation.options.body).byteLength > 65536);
  assert.equal(creation.options.keepalive, false); assert.deepEqual(errors, []);
  worker.postMessage({ type: 'pause' }); await flush(); await worker.terminate();
  assert.deepEqual(f.commands().map(call => [call.body.type, call.options.keepalive]), [['pause', true], ['cancel', true]]);
});

test('temporary packet failure retries the same sequence and reports connected only after recovery succeeds', async t => {
  const f = fixture(t), recovered = deferred(); let attempts = 0;
  f.route = call => {
    if (call.url.endsWith('/messages/1')) return ++attempts === 1 ? jsonResponse({ error: 'Temporary error' }, 503) : recovered.promise;
  };
  const { worker, messages, errors } = f.worker(); worker.postMessage({ type: 'start', requestId: 3, input: {} }); await flush();
  f.streams[0].emit('notice', { seq: 1 }); await flush();
  assert.deepEqual(messages.map(message => message.connected), [false]); assert.equal(f.timers.size, 1);
  f.runTimer(); await flush();
  assert.deepEqual(messages.map(message => message.connected), [false], 'Retry initiation is not successful recovery');
  recovered.resolve(new Response(encodePacket({ type: 'status', mode: 'done', next: 1, total: 1 }))); await flush();
  assert.deepEqual(f.messageRequests(), [1, 1]); assert.deepEqual(errors, []);
  assert.deepEqual(messages.filter(message => message.type === 'connection').map(message => message.connected), [false, true]);
  assert.equal(messages.at(-1).mode, 'done'); assert.equal(f.timers.size, 0);
});

test('failed control commands report nonfatal notices without cancelling or closing the result stream', async t => {
  const f = fixture(t), { worker, messages, errors } = f.worker();
  worker.postMessage({ type: 'start', requestId: 23, input: {} }); await flush();
  let actualStatus = 'running';
  f.route = call => call.url.endsWith('/command')
    ? call.body.type === 'resume' ? Promise.reject(new Error('Network unavailable')) : jsonResponse({ error: 'Temporary error' }, 503)
    : call.url === '/api/jobs/job-1' ? jsonResponse({ ...f.job, status: actualStatus, next: 7, total: 120 }) : undefined;
  for (const type of ['pause', 'resume', 'step']) {
    actualStatus = type === 'pause' ? 'running' : 'paused'; worker.postMessage({ type }); await flush();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(messages.filter(message => message.type === 'command-error'), [
    { type: 'command-error', command: 'pause', message: 'Temporary error', requestId: 23 },
    { type: 'command-error', command: 'resume', message: 'Network unavailable', requestId: 23 },
    { type: 'command-error', command: 'step', message: 'Temporary error', requestId: 23 },
  ].map(message => ({ ...message, job: { ...f.job, status: message.command === 'pause' ? 'running' : 'paused', next: 7, total: 120 } })));
  assert.deepEqual(f.commands().map(call => call.body.type), ['pause', 'resume', 'step']);
  assert.equal(f.streams[0].closed, false); assert.equal(f.storage.get(savedKey), f.job.id);
  f.packets.set(1, encodePacket({ type: 'status', mode: 'done', next: 2, total: 2 }));
  f.streams[0].emit('notice', { seq: 1 }); await flush();
  assert.equal(messages.at(-1).mode, 'done'); assert.deepEqual(errors, []);
  assert.equal(f.commands().some(call => call.body.type === 'cancel'), false);
});

test('failed command state recovery stays nonfatal and does not invent a server state', async t => {
  const f = fixture(t), { worker, messages, errors } = f.worker();
  worker.postMessage({ type: 'start', requestId: 24, input: {} }); await flush();
  f.route = call => call.url.endsWith('/command') || call.url === '/api/jobs/job-1'
    ? Promise.reject(new Error('Network unavailable')) : undefined;
  worker.postMessage({ type: 'pause' }); await flush();
  assert.deepEqual(messages.at(-1), { type: 'command-error', command: 'pause', message: 'Network unavailable',
    requestId: 24, job: null, recoveryError: 'Network unavailable' });
  assert.equal(f.streams[0].closed, false); assert.deepEqual(errors, []);
  assert.equal(f.storage.get(savedKey), f.job.id); assert.equal(f.commands().length, 1);
});

test('explicit terminate retries cancellation after detaching and clears the saved ID only after confirmation', async t => {
  const f = fixture(t), { worker } = f.worker();
  worker.postMessage({ type: 'start', requestId: 25, input: {} }); await flush();
  let attempts = 0;
  f.route = call => call.url.endsWith('/command') && ++attempts === 1 ? jsonResponse({ error: 'Temporary error' }, 503) : undefined;
  const cancellation = worker.terminate();
  assert.equal(worker.terminate(), cancellation); await flush();
  assert.equal(f.streams[0].closed, true); assert.equal(f.storage.get(savedKey), f.job.id);
  assert.equal(f.commands().length, 1); f.runTimer(); await cancellation;
  assert.equal(f.commands().length, 2); assert.equal(f.storage.has(savedKey), false);
  assert.equal(f.timers.size, 0);
});

test('unconfirmed termination rejects after bounded retries and leaves the server job recoverable', async t => {
  const f = fixture(t), { worker, errors } = f.worker();
  worker.postMessage({ type: 'start', requestId: 26, input: {} }); await flush();
  f.route = call => call.url.endsWith('/command') ? jsonResponse({ error: 'Temporary error' }, 503) : undefined;
  const rejected = assert.rejects(worker.terminate(), /Temporary error/); await flush();
  f.runTimer(); await flush(); f.runTimer(); await rejected;
  assert.equal(f.commands().length, 3); assert.equal(f.timers.size, 0); assert.deepEqual(errors, []);
  assert.equal(f.storage.get(savedKey), f.job.id);
  assert.equal((await connectComputeServer()).job.id, f.job.id);
});

test('an already missing job confirms termination without retrying', async t => {
  const f = fixture(t), { worker } = f.worker();
  worker.postMessage({ type: 'start', requestId: 27, input: {} }); await flush();
  f.route = call => call.url.endsWith('/command') ? jsonResponse({ error: 'Job expired' }, 404) : undefined;
  await worker.terminate();
  assert.equal(f.commands().length, 1); assert.equal(f.storage.has(savedKey), false); assert.equal(f.timers.size, 0);
});

test('expired messages and corrupt diagnostic packets fail once instead of retrying forever', async t => {
  const f = fixture(t), first = f.worker(); first.worker.postMessage({ type: 'start', requestId: 4, input: {} }); await flush();
  f.streams[0].emit('notice', { seq: 1 }); await flush();
  assert.equal(first.errors.length, 1); assert.match(first.errors[0], /Message unavailable/);
  assert.equal(f.timers.size, 0); assert.equal(f.streams[0].closed, true); assert.equal(f.storage.has(savedKey), false);
  f.packets.set(1, new Uint8Array([1, 2]));
  const second = f.worker(); second.worker.postMessage({ type: 'start', requestId: 5, input: {} }); await flush();
  f.streams[1].emit('notice', { seq: 1 }); await flush();
  assert.equal(second.errors.length, 1); assert.match(second.errors[0], /Invalid simulation result/);
  assert.equal(f.timers.size, 0); assert.equal(f.commands().length, 0);
});

test('SSE job expiry and explicit server storage errors are surfaced without automatic cancellation', async t => {
  const f = fixture(t), first = f.worker(); first.worker.postMessage({ type: 'start', requestId: 6, input: {} }); await flush();
  f.route = call => call.url === '/api/jobs/job-1' ? jsonResponse({ error: 'Job expired' }, 404) : undefined;
  f.streams[0].readyState = 2; f.streams[0].emit('error'); await flush();
  assert.deepEqual(first.errors, ['Job expired']); assert.equal(f.timers.size, 0);
  f.route = null;
  const second = f.worker(); second.worker.postMessage({ type: 'start', requestId: 7, input: {} }); await flush();
  f.streams[1].emit('server-error', { message: 'Disk is full' });
  assert.deepEqual(second.errors, ['Disk is full']); assert.equal(f.commands().length, 0);
});

test('a temporarily failed reconnect preserves the saved job; a create-before-refresh race can recover the sole active job', async t => {
  const f = fixture(t); f.storage.set(savedKey, f.job.id);
  f.route = call => call.url === '/api/jobs/job-1' ? Promise.reject(new Error('Network unavailable')) : undefined;
  await assert.rejects(connectComputeServer(), /Network unavailable/); assert.equal(f.storage.get(savedKey), f.job.id);
  f.storage.clear(); f.route = call => call.url === '/api/jobs' ? jsonResponse({ jobs: [{ ...f.job, status: 'done' }, f.job] }) : undefined;
  const connected = await connectComputeServer(); assert.equal(connected.job.status, 'running'); assert.equal(f.storage.get(savedKey), f.job.id);
});

test('sweep completion sorts independently completed jobs into input order and retains all records', async t => {
  const f = fixture(t), progress = [], jobs = [{ seed: 1 }, { seed: 2 }, { seed: 3 }];
  [
    { type: 'sweep-result', id: 2, result: { seed: 3 } },
    { type: 'sweep-result', id: 0, result: { seed: 1 } },
    { type: 'sweep-progress', id: 1, t: 7, total: 10 },
    { type: 'sweep-result', id: 1, result: { seed: 2 } },
    { type: 'status', mode: 'done', next: 3, total: 3 },
  ].forEach((message, i) => f.packets.set(i + 1, encodePacket(message)));
  const sweep = startServerSweep({}, jobs, value => progress.push(value)); await flush();
  f.streams[0].emit('notice', { seq: 5 });
  const result = await sweep.promise;
  assert.deepEqual(result, { results: [{ seed: 1 }, { seed: 2 }, { seed: 3 }], cancelled: false });
  assert.ok(progress.some(value => value.progress.type === 'sweep-progress' && value.completed === 2));
  assert.equal(f.commands().length, 0);
});

test('cancelling a sweep before creation drains completed server records before resolving a sorted partial result', async t => {
  const f = fixture(t), creation = deferred(); let settled = false;
  f.route = call => call.url === '/api/jobs' && call.options.method === 'POST' ? creation.promise : undefined;
  const sweep = startServerSweep({}, [{ seed: 1 }, { seed: 2 }, { seed: 3 }], () => {});
  sweep.promise.then(() => { settled = true; }); sweep.cancel(); sweep.cancel();
  creation.resolve(jsonResponse(f.job, 201)); await flush();
  assert.equal(settled, false, 'Cancellation must wait for retained result records and server terminal status');
  assert.deepEqual(f.commands().map(call => call.body), [{ type: 'cancel' }]);
  [
    { type: 'sweep-result', id: 2, result: { seed: 3 } },
    { type: 'sweep-result', id: 0, result: { seed: 1 } },
    { type: 'status', mode: 'cancelled', next: 2, total: 3 },
  ].forEach((message, i) => f.packets.set(i + 1, encodePacket(message)));
  f.streams[0].emit('notice', { seq: 3 });
  assert.deepEqual(await sweep.promise, { results: [{ seed: 1 }, { seed: 3 }], cancelled: true });
});

test('an unconfirmed sweep cancellation keeps receiving results and permits a later cancellation attempt', async t => {
  const f = fixture(t), progress = [];
  const sweep = startServerSweep({}, [{ seed: 1 }, { seed: 2 }], value => progress.push(value));
  let settled = false; sweep.promise.then(() => { settled = true; }); await flush();
  f.route = call => call.url.endsWith('/command') ? jsonResponse({ error: 'Temporary error' }, 503) : undefined;
  sweep.cancel(); await flush(); f.runTimer(); await flush(); f.runTimer(); await flush();
  assert.equal(settled, false); assert.equal(f.streams[0].closed, false);
  assert.equal(f.storage.get(savedKey), f.job.id); assert.equal(f.commands().length, 3);
  assert.deepEqual(progress.at(-1).progress, { type: 'command-error', command: 'cancel',
    message: 'Temporary error', requestId: 0, job: f.job });
  f.route = null; sweep.cancel(); await flush();
  assert.equal(f.commands().length, 4); assert.equal(f.storage.has(savedKey), false);
  f.packets.set(1, encodePacket({ type: 'sweep-result', id: 1, result: { seed: 2 } }));
  f.packets.set(2, encodePacket({ type: 'status', mode: 'cancelled', next: 1, total: 2 }));
  f.streams[0].emit('notice', { seq: 2 });
  assert.deepEqual(await sweep.promise, { results: [{ seed: 2 }], cancelled: true });
});

test('failed or incomplete server sweeps cannot be reported as successfully completed', async t => {
  const f = fixture(t);
  for (const [message, expected] of [[{ type: 'status', mode: 'done' }, /missing results/], [{ type: 'status', mode: 'failed', message: 'Estimator failure' }, /Estimator failure/]]) {
    f.packets.set(1, encodePacket(message));
    const sweep = startServerSweep({}, [{ seed: 1 }], () => {}), rejected = assert.rejects(sweep.promise, expected);
    await flush(); f.streams.at(-1).emit('notice', { seq: 1 }); await rejected;
  }
  assert.equal(f.commands().length, 0); assert.equal(f.timers.size, 0);
});

test('a later diagnostic delta retries without duplicating an already decoded prefix', async t => {
  const f = fixture(t); comparisonPackets().forEach((packet, i) => f.packets.set(i + 1, packet)); let attempts = 0;
  f.route = call => call.url.endsWith('/messages/4') && ++attempts === 1 ? jsonResponse({ error: 'Temporary transfer error' }, 503) : undefined;
  const { worker, messages, errors } = f.worker(); worker.postMessage({ type: 'start', requestId: 18, input: {} }); await flush();
  f.streams[0].emit('notice', { seq: 5 }); await flush();
  assert.deepEqual(messages.filter(message => message.type === 'frame').map(message => message.next), [1]);
  f.runTimer(); await flush();
  assert.deepEqual(f.messageRequests(), [1, 2, 3, 4, 4, 5]); assert.deepEqual(errors, []);
  const frames = messages.filter(message => message.type === 'frame');
  assert.deepEqual(frames.map(message => Array.from(message.evaluation.diagnostics.ratios)), [[.5], [.5, 1.5]]);
});

test('the actual app unload handler detaches server jobs and stops only browser-owned workers', () => {
  const source = readFileSync(new URL('../../drf/app.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf("window.addEventListener('beforeunload'"), end = source.indexOf('let initialInput', begin);
  assert.ok(begin >= 0 && end > begin);
  const calls = [], state = { workers: [
    { detach: () => calls.push('server detached'), stop: () => assert.fail('Unloading must not cancel a server comparison') },
    { stop: () => calls.push('browser stopped') },
  ], sweep: { detach: () => calls.push('sweep detached'), cancel: () => assert.fail('Unloading must not cancel a server sweep') } };
  let unload;
  vm.runInNewContext(source.slice(begin, end), { state, window: { addEventListener: (name, callback) => { assert.equal(name, 'beforeunload'); unload = callback; } } });
  unload(); assert.deepEqual(calls, ['server detached', 'browser stopped', 'sweep detached']);
  calls.length = 0; state.sweep = { cancel: () => calls.push('browser sweep stopped') };
  unload(); assert.deepEqual(calls, ['server detached', 'browser stopped', 'browser sweep stopped']);
});
