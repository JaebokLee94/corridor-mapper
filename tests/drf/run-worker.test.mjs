import { fileURLToPath } from 'node:url';
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
    .filter(([key]) => !['ms', 'psptMs', 'simulatorMs', 'backend', 'gpuCalls', 'gpuCallsThisStep'].includes(key)).map(([key, item]) => [key, numerical(item)]));
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
    globalThis.Worker=require(${JSON.stringify(fileURLToPath(new URL('./nested-worker.cjs',import.meta.url)))});
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

for(const blockedSide of ['echoSpline','guarded']){
  test(`the other estimator can finish while ${blockedSide} is still processing snapshot one`,async()=>{
    const messages=[],release=Promise.withResolvers();
    const engine=createRunEngine({emit:m=>messages.push(m),createMethod:side=>({
      async step(wire){
        if(side===blockedSide&&wire.t===1)await release.promise;
        return {candidates:[],curves:[],ms:1};
      },close(){}
    })});
    const finished=engine.command({type:'start',requestId:1,input});
    try{
      await waitUntil(()=>messages.some(m=>m.type==='method-frame'&&m.t===input.snapshots),'fast side must progress independently');
      assert.deepEqual(messages.filter(m=>m.type==='method-frame').map(m=>[m.side,m.t]),[1,2,3].map(t=>[blockedSide==='echoSpline'?'guarded':'echoSpline',t]));
      assert.equal(messages.some(m=>m.type==='frame'||m.mode==='done'),false);
      const early = messages.filter(m => m.field);
      assert.deepEqual(early.map(m => m.field.t), blockedSide === 'guarded' ? [1,2,3] : []);
      const {scenario,grid} = messages.find(m => m.type === 'prepared');
      const field = createField(grid, {band:scenario.input.band, perimeter:scenario.input.perimeter});
      for (const m of early) {
        const expected = field.step(scenario.wire[m.t-1]);
        assert.deepEqual(m.field.Dbar, expected.Dbar);
        assert.deepEqual(m.field.betaHat, expected.betaHat);
      }
    }finally{release.resolve();await finished;}
    assert.deepEqual(messages.filter(m=>m.type==='frame').map(m=>m.next),[1,2,3]);
    assert.equal(messages.at(-1).mode,'done');
  });
}

test('independent learned estimators produce the same prefix outputs as a joint comparison',async()=>{
  const scene=await generateScenario({...input,scene:'paper-upper',seed:3296639392,snapshots:16});
  for(const rightMethod of ['spline-cnn','gbdt','gat','arc']){
    const settings={...scene.input,rightMethod},joint=new EchoComparison(settings,scene.domain),
      left=new EchoComparison(settings,scene.domain,'echoSpline'),right=new EchoComparison(settings,scene.domain,'guarded');
    await Promise.all([joint.loadModel(),right.loadModel({useGpu:rightMethod==='arc'})]);
    for(const wire of scene.wire){
      const reference=joint.step(wire);
      assert.deepEqual(numerical(left.stepLeft(wire)),numerical(reference.echoSpline));
      const {stageTotalsMs,backend,gpuCalls,gpuAdapter,gpuMode,gpuReadbacks,gpuCompact,gpuInputBytes,gpuOutputBytes,gpuOverflowReadbacks,...single}=await right.stepSide('guarded',wire);
      if(rightMethod==='arc'){
        assert.ok(backend==='CPU WASM'||backend==='WebGPU');
        assert.equal(typeof gpuAdapter,'string');
        if(backend==='WebGPU')assert.ok(gpuCalls>0);
        else assert.equal(gpuCalls,0);
        if(gpuMode==='resident')assert.equal(gpuCalls,11*(gpuReadbacks-(gpuOverflowReadbacks??0)));
        if(gpuCompact){
          assert.ok(gpuInputBytes>0 && gpuOutputBytes>0);
          assert.ok(Number.isInteger(gpuOverflowReadbacks) && gpuOverflowReadbacks>=0);
        }
      }
      assert.deepEqual(numerical(single),numerical(reference.guarded));
      if(rightMethod==='gat'){
        assert.ok(stageTotalsMs.gat>=0 && stageTotalsMs.gpr>=0);
        if(wire.t===scene.wire.length)assert.ok(stageTotalsMs.gat>0 && stageTotalsMs.gpr>0);
      }else assert.equal(stageTotalsMs,undefined);
    }
    right.close();
  }
});

test('asynchronous EchoSpline screening preserves each prefix and recovers from device loss',async()=>{
  const scene=await generateScenario({...input,scene:'paper-upper',seed:3296639392,snapshots:16});
  const reference=new EchoComparison(scene.input,scene.domain,'echoSpline');
  const tested=new EchoComparison(scene.input,scene.domain,'echoSpline');
  let fail=false,destroyed=false,batches=0;
  tested.splineGpu={
    completedCalls:0,adapterInfo:{vendor:'test'},
    bind(x,observations){
      const mask=new Uint32Array(observations.length*Math.ceil(x.length/32)).fill(0xffffffff);
      const scan=async ()=>{
        if(fail)throw Error('Device lost');
        this.completedCalls++;return mask;
      };
      scan.batch=async heights=>{
        assert.equal(heights.length,4);
        await scan();batches++;return heights.map(()=>mask);
      };
      return scan;
    },
    destroy(){destroyed=true;}
  };
  let previous=0;
  for(const wire of scene.wire){
    if(wire.t===12)fail=true;
    const {ms,backend,gpuAdapter,gpuCallsThisStep,gpuCalls,...actual}=await tested.stepLeft(wire,true);
    const {ms:originalMs,...expected}=reference.stepLeft(wire,true);
    assert.deepEqual(actual,expected);
    assert.equal(gpuCallsThisStep,gpuCalls-previous);
    assert.equal(backend,gpuCallsThisStep?'WebGPU + CPU':'CPU');
    previous=gpuCalls;
  }
  assert.ok(previous>0 && batches>0 && destroyed);
  assert.equal(tested.spline.obs.length,reference.spline.obs.length);
});

test('EchoSpline requests an adapter only for WebGPU selection and reports a CPU fallback',async()=>{
  let requests=0;
  const previous=Object.getOwnPropertyDescriptor(navigator,'gpu');
  Object.defineProperty(navigator,'gpu',{configurable:true,value:{async requestAdapter(){requests++;return null;}}});
  try{
    const scene=await generateScenario(input),wire=scene.wire[0];
    const make=echoBackend=>new EchoComparison({...scene.input,echoBackend},scene.domain,'echoSpline');
    for(const choice of [undefined,'cpu']){
      const cpu=make(choice);
      await cpu.loadModel({useGpu:true});cpu.stepLeft(wire);cpu.close();
    }
    assert.equal(requests,0);
    const fallback=make('gpu');await fallback.loadModel({useGpu:true});
    assert.equal(requests,1);
    const result=await fallback.stepLeft(wire);
    assert.equal(result.backend,'CPU');assert.equal(result.gpuCalls,0);assert.equal(result.gpuCallsThisStep,0);
    fallback.close();assert.throws(()=>make('invalid'),/compute device/);
  }finally{
    if(previous)Object.defineProperty(navigator,'gpu',previous);
    else delete navigator.gpu;
  }
});
