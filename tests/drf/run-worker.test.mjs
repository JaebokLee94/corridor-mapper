import { EchoComparison,echoProtocol } from '../../drf/echo-comparison.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRunEngine } from '../../drf/run-engine.mjs';
import { generateScenario } from '../../drf/scenario.mjs';
import { createGrid, createField } from '../../drf/field.mjs';
import { MethodComparison, protocolForFleet } from '../../drf/comparison.mjs';
import { createPSPTEvaluator } from '../../drf/pspt-evaluate.mjs';

const input = { scene: 'reference', vehicles: 3, snapshots: 3, grid: 100,
  roughness: 2, cellStep: .2, seed: 42, sigmaP: .1, sigmaD: .1 };
const numerical = value => {
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map(numerical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['ms', 'psptMs', 'simulatorMs'].includes(key)).map(([key, item]) => [key, numerical(item)]));
  return value;
};
const waitUntil = async (condition, message) => {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message); await delay(10);
  }
};

async function moduleWorker(completion) {
  const url = new URL('../../drf/run.worker.mjs', import.meta.url).href;
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const completed=new Int32Array(workerData.completion);
    globalThis.postMessage=(message,transfer)=>{
      parentPort.postMessage(message,transfer);
      if(message.type==='status'&&message.mode==='done') Atomics.store(completed,0,1);
    };
    import(${JSON.stringify(url)}).then(()=>{
      parentPort.on('message',data=>globalThis.onmessage({data}));
      parentPort.postMessage({type:'ready'});
    }).catch(error=>{throw error;});
  `, { eval: true, workerData: { completion: completion.buffer } });
  const [ready] = await once(worker, 'message'); assert.equal(ready.type, 'ready'); return worker;
}

test('autonomous engine matches the existing foreground kernels for every measured prefix', async () => {
  const messages = [], engine = createRunEngine({ emit: message => messages.push(structuredClone(message)) });
  await engine.command({ type: 'start', requestId: 17, input });
  assert.ok(messages.every(message => message.requestId === 17));
  const prepared = messages.find(message => message.type === 'prepared'), frames = messages.filter(message => message.type === 'frame');
  const scene = await generateScenario(input), grid = createGrid(100, 100, scene.domain);
  assert.deepEqual(numerical(prepared.scenario), numerical(scene)); assert.deepEqual(prepared.grid, grid);
  assert.deepEqual(prepared.protocol, echoProtocol(input));
  const field = createField(grid, { band: scene.input.band, perimeter: scene.input.perimeter });
  const estimator = new EchoComparison(scene.input,scene.domain);
  const guardedEvaluator = createPSPTEvaluator(scene, grid), baselineEvaluator = createPSPTEvaluator(scene, grid);
  assert.equal(frames.length, input.snapshots);
  for (let i = 0; i < frames.length; i++) {
    const wire = scene.wire[i], frame = field.step(wire), methods = estimator.step(wire);
    Object.assign(frame, { methods, candidates: methods.guarded.candidates, psptMs: methods.guarded.ms, method: 'guarded-tuned' });
    const guarded = guardedEvaluator.step(frame,null,methods.guarded.bridges,methods.guarded.extendedBridges), echoSpline = baselineEvaluator.step({...frame,...methods.echoSpline},guarded);
    assert.deepEqual(numerical(frames[i].frame), numerical(frame), `unchanged numerical frame at t=${i + 1}`);
    assert.deepEqual(numerical(frames[i].evaluation), numerical({ ...guarded, methods: { echoSpline, guarded } }));
    assert.equal(frames[i].next, i + 1);
  }
  assert.deepEqual(messages.at(-1), { type: 'status', requestId: 17, mode: 'done', next: input.snapshots, total: input.snapshots });
});

test('actual worker completes 120 snapshots without a parent result consumer or acknowledgement', async t => {
  const completion = new Int32Array(new SharedArrayBuffer(4)), worker = await moduleWorker(completion);
  t.after(() => worker.terminate());
  assert.equal(worker.listenerCount('message'), 0, 'no progress/frame/status listener remains after readiness');
  worker.postMessage({ type: 'start', requestId: 18, input: { ...input, vehicles: 2, snapshots: 120, roughness: 0, specular: false } });
  await waitUntil(() => Atomics.load(completion, 0) === 1, 'worker should finish while its output queue is unconsumed');
  assert.equal(worker.listenerCount('message'), 0);
});

test('actual worker accepts step and resume commands between transferable frame messages', async t => {
  const completion = new Int32Array(new SharedArrayBuffer(4)), worker = await moduleWorker(completion), messages = [];
  t.after(() => worker.terminate());
  worker.on('message', message => messages.push(message));
  worker.postMessage({ type: 'start', requestId: 23, input, single: true });
  await waitUntil(() => messages.some(message => message.mode === 'paused' && message.next === 1), 'single step should pause after its first frame');
  worker.postMessage({ type: 'step', requestId: 23 });
  await waitUntil(() => messages.some(message => message.mode === 'paused' && message.next === 2), 'step should pause after its second frame');
  worker.postMessage({ type: 'resume', requestId: 23 });
  await waitUntil(() => messages.some(message => message.mode === 'done'), 'resume should finish the remaining snapshot');
  const frames = messages.filter(message => message.type === 'frame');
  assert.deepEqual(frames.map(message => message.next), [1, 2, 3]);
  assert.ok(frames.every(message => message.frame.Dbar instanceof Float32Array && message.frame.Dbar.length === 10000));
  assert.ok(frames.every(message => message.frame.betaHat instanceof Float32Array && message.frame.betaHat.length === 10000));
  assert.deepEqual(messages.filter(message => message.type === 'error'), []);
});

test('pause preserves the current prefix, step adds one snapshot, resume preserves ordering', async () => {
  const frames = [], statuses = []; let engine;
  engine = createRunEngine({ emit(message) {
    if (message.type === 'frame') {
      frames.push(message.frame.t);
      if (message.next === 1) engine.command({ type: 'pause', requestId: 19 });
    }
    if (message.type === 'status') statuses.push(message.mode);
  } });
  await engine.command({ type: 'start', requestId: 19, input });
  assert.deepEqual(frames, [1]); assert.equal(statuses.at(-1), 'paused');
  await delay(20); assert.deepEqual(frames, [1], 'paused work cannot restart without a command');
  await engine.command({ type: 'step', requestId: 19 });
  assert.deepEqual(frames, [1, 2]); assert.equal(statuses.at(-1), 'paused');
  await engine.command({ type: 'resume', requestId: 19 });
  assert.deepEqual(frames, [1, 2, 3]); assert.equal(statuses.at(-1), 'done');
});

test('single-step starts paused after one prefix and stale/cancelled commands cannot restart it', async () => {
  const messages = [], engine = createRunEngine({ emit: message => messages.push(structuredClone(message)) });
  await engine.command({ type: 'start', requestId: 20, input, single: true });
  assert.equal(messages.filter(message => message.type === 'frame').length, 1);
  assert.equal(messages.at(-1).mode, 'paused');
  await engine.command({ type: 'resume', requestId: 19 });
  engine.command({ type: 'cancel', requestId: 20 });
  const count = messages.length;
  await engine.command({ type: 'resume', requestId: 20 });
  await engine.command({ type: 'step', requestId: 20 });
  assert.equal(messages.length, count); assert.equal(messages.at(-1).mode, 'cancelled');
});

test('cancellation during a yielded run emits no later frame or completion', async () => {
  const messages = []; let engine;
  engine = createRunEngine({ emit(message) {
    messages.push(structuredClone(message));
    if (message.type === 'frame') engine.command({ type: 'cancel', requestId: 21 });
  } });
  await engine.command({ type: 'start', requestId: 21, input });
  assert.deepEqual(messages.filter(message => message.type === 'frame').map(message => message.next), [1]);
  assert.equal(messages.at(-1).mode, 'cancelled');
  assert.ok(!messages.some(message => message.mode === 'done'));
});

test('cancellation during generation suppresses prepared data and all inference output', async () => {
  const messages = []; let engine;
  engine = createRunEngine({ emit(message) {
    messages.push(message);
    if (message.type === 'progress') engine.command({ type: 'cancel', requestId: 22 });
  } });
  await engine.command({ type: 'start', requestId: 22, input });
  assert.deepEqual(messages.map(message => message.type), ['status', 'preparation', 'progress', 'status']);
  assert.equal(messages.at(-1).mode, 'cancelled');
});
