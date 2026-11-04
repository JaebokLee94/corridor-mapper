import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunPreloader } from '../../drf/run-preloader.mjs';
import { normalizeInput } from '../../drf/scenario.mjs';

const input = normalizeInput({ seed: 1, vehicles: 10, snapshots: 120 });
function harness(factory) {
  let next = 0;
  const timers = new Map(), created = [], delays = [];
  const makeWorker = () => {
    const worker = { messages: [], stopped: 0, onerror: null,
      postMessage(message) { this.messages.push(message); }, terminate() { this.stopped++; } };
    created.push(worker); return worker;
  };
  const preloader = createRunPreloader({ createWorker: factory ?? makeWorker,
    setTimer(callback, delay) { delays.push(delay); timers.set(next, callback); return next++; },
    clearTimer(id) { timers.delete(id); } });
  return { preloader, timers, created, delays,
    flush() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); } };
}

test('idle warmup is debounced and sends only stored-truth lookup, never a run', () => {
  const h = harness();
  h.preloader.schedule(input);
  assert.equal(h.created.length, 0); assert.equal(h.timers.size, 1); assert.deepEqual(h.delays, [180]);
  h.flush();
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.created[0].messages, [{ type: 'warm-truth', input }]);
  assert.equal(h.created[0].stopped, 0);
});

test('only bank seeds and supported normalized capacity can allocate idle workers', () => {
  const h = harness();
  for (const changed of [null, { seed: 0 }, { seed: 11 }, { seed: 1.5 },
    { vehicles: 1 }, { vehicles: 11 }, { vehicles: 2.5 }, { snapshots: 0 },
    { snapshots: 121 }, { snapshots: 1.5 }, { sigmaM: NaN }]) {
    h.preloader.schedule(changed === null ? null : { ...input, ...changed });
    h.flush();
  }
  assert.equal(h.created.length, 0);
  for (const seed of [1, 10]) {
    h.preloader.schedule({ ...input, seed, vehicles: 2, snapshots: 1 }); h.flush();
  }
  assert.equal(h.created.length, 2); assert.equal(h.created[0].stopped, 1);
});

test('measurement noise and display edits reuse the same pending or warmed physical input', () => {
  const h = harness();
  const changed = { ...input, sigmaP: .3, sigmaD: .4, grid: 100, band: 3, resolution: .2, specular: false };
  h.preloader.schedule(input); h.preloader.schedule(changed);
  assert.equal(h.delays.length, 1); h.flush();
  h.preloader.schedule(changed); h.flush();
  assert.equal(h.created.length, 1);
  assert.equal(h.preloader.take(changed), h.created[0]);
});

test('physical or vehicle/time capacity changes replace the owned warmup', () => {
  const h = harness();
  h.preloader.schedule(input);
  h.preloader.schedule({ ...input, seed: 2 });
  assert.equal(h.timers.size, 1); h.flush();
  assert.equal(h.created[0].messages[0].input.seed, 2);
  for (const changed of [{ roughness: 5 }, { vehicles: 3 }, { snapshots: 60 }]) {
    const previous = h.created.at(-1);
    h.preloader.schedule({ ...input, ...changed });
    assert.equal(previous.stopped, 1); assert.equal(h.timers.size, 1); h.flush();
  }
  assert.equal(h.created.filter(worker => worker.stopped === 0).length, 1);
});

test('Run takes only a matching worker and cancels an unstarted timer synchronously', () => {
  const h = harness();
  h.preloader.schedule(input);
  assert.equal(h.preloader.take(input), null); assert.equal(h.timers.size, 0);
  h.flush(); assert.equal(h.created.length, 0);
  h.preloader.schedule(input); h.flush();
  assert.equal(h.preloader.take({ ...input, seed: 2 }), null); assert.equal(h.created[0].stopped, 1);
  h.preloader.schedule(input); h.flush();
  assert.equal(h.preloader.take(input), h.created[1]);
  assert.equal(h.preloader.take(input), null);
});

test('ownership transfer protects the running worker from later disposal and stale error callbacks', () => {
  const h = harness(); h.preloader.schedule(input); h.flush();
  const worker = h.created[0], staleError = worker.onerror;
  assert.equal(h.preloader.take(input), worker); assert.equal(worker.onerror, null);
  h.preloader.schedule({ ...input, seed: 2 }); h.flush(); staleError();
  assert.equal(worker.stopped, 0); assert.equal(h.created[1].stopped, 0);
  h.preloader.dispose(); h.preloader.dispose();
  assert.equal(worker.stopped, 0); assert.equal(h.created[1].stopped, 1);
});

test('factory, postMessage and idle-worker errors fall back without blocking Run', () => {
  const factoryFailure = harness(() => { throw new Error('worker unsupported'); });
  factoryFailure.preloader.schedule(input); assert.doesNotThrow(() => factoryFailure.flush());
  assert.equal(factoryFailure.preloader.take(input), null);
  let stopped = 0;
  const postFailure = harness(() => ({ postMessage() { throw new Error('clone failed'); }, terminate() { stopped++; } }));
  postFailure.preloader.schedule(input); assert.doesNotThrow(() => postFailure.flush());
  assert.equal(stopped, 1); assert.equal(postFailure.preloader.take(input), null);
  const h = harness(); h.preloader.schedule(input); h.flush(); h.created[0].onerror();
  assert.equal(h.created[0].stopped, 1); assert.equal(h.preloader.take(input), null);
  h.preloader.schedule(input); h.flush(); assert.equal(h.created.length, 2);
});
