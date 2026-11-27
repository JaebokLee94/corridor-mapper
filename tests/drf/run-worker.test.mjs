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
import { createDisplayField } from '../../drf/display-field.mjs';
import { MethodComparison, protocolForFleet } from '../../drf/comparison.mjs';
import { createPSPTEvaluator } from '../../drf/pspt-evaluate.mjs';

const input = { scene: 'reference', vehicles: 3, snapshots: 3, grid: 100,
  roughness: 2, cellStep: .2, seed: 42, sigmaP: .1, sigmaD: .1 };
function referenceDisplayFrame(scene, grid, t) {
  const field = createField(grid, { band: scene.input.band, perimeter: scene.input.perimeter });
  for (const wire of scene.wire.slice(0, t - 1)) field.step(wire);
  return { ...field.step(scene.wire[t - 1]), grid };
}
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
  const estimator = new EchoComparison(scene.input,scene.domain);
  const guardedEvaluator = createPSPTEvaluator(scene, grid), baselineEvaluator = createPSPTEvaluator(scene, grid);
  assert.equal(frames.length, input.snapshots);
  for (let i = 0; i < frames.length; i++) {
    const frame = referenceDisplayFrame(scene, frames[i].frame.grid, i + 1), methods = estimator.step(scene.wire[i]);
    assert.ok(frame.grid.xmin < grid.xmin, 'the measured left ellipse tips extend past the reference wall');
    Object.assign(frame, { methods, candidates: methods.guarded.candidates, psptMs: methods.guarded.ms, method: 'guarded-tuned' });
    const guarded = guardedEvaluator.step(frame,null,methods.guarded.bridges,methods.guarded.extendedBridges), echoSpline = baselineEvaluator.step({...frame,...methods.echoSpline},guarded);
    assert.deepEqual(numerical(frames[i].frame), numerical(frame), `field and estimator outputs at t=${i + 1}`);
    assert.deepEqual(numerical(frames[i].evaluation), numerical({ ...guarded, methods: { echoSpline, guarded } }));
    assert.equal(frames[i].next, i + 1);
  }
  assert.deepEqual(messages.at(-1), { type: 'status', requestId: 17, mode: 'done', next: input.snapshots, total: input.snapshots });
});

test('worker computation clock excludes preparation and paused time across step and resume',async t=>{
  const scenario=await generateScenario(input),messages=[];let now=1000;
  t.mock.method(performance,'now',()=>now);
  const engine=createRunEngine({emit:message=>messages.push(message),
    prepare:async()=>{now+=5000;return scenario;},
    createMethod:()=>({async step(){now+=10;return {candidates:[],curves:[],ms:1};},close(){}})});
  await engine.command({type:'start',requestId:1,input,single:true});
  now+=10000;
  await engine.command({type:'step',requestId:1});
  now+=10000;
  await engine.command({type:'resume',requestId:1});
  const clocks=messages.filter(message=>message.type==='compute-clock');
  assert.deepEqual(clocks.map(({elapsedMs,running})=>[elapsedMs,running]),
    [[0,true],[20,false],[20,true],[40,false],[40,true],[60,false]]);
  assert.ok(messages.findIndex(message=>message.type==='prepared')<messages.indexOf(clocks[0]));
  for(const side of ['echoSpline','guarded']){
    assert.deepEqual(messages.filter(message=>message.type==='method-frame'&&message.side===side).map(message=>message.at),[20,40,60]);
  }
  assert.equal(messages.at(-1).mode,'done');
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
  for (const { frame } of frames) {
    const cells = frame.grid.nx * frame.grid.ny;
    assert.ok(cells > input.grid ** 2);
    assert.ok(frame.Dbar instanceof Float32Array && frame.Dbar.length === cells);
    assert.ok(frame.betaHat instanceof Float32Array && frame.betaHat.length === cells);
  }
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
    const messages=[],release=Promise.withResolvers(),fieldRelease=Promise.withResolvers();
    const engine=createRunEngine({emit:m=>messages.push(m),createMethod:side=>({
      async step(wire){
        if(side===blockedSide&&wire.t===1)await release.promise;
        return {candidates:[],curves:[],ms:1};
      },close(){}
    }),createFieldClient(grid,numerical){
      const field=createDisplayField(grid,numerical);
      return {async step(wire){
        if(blockedSide==='guarded' && wire.t===1)await fieldRelease.promise;
        return field.step(wire);
      },close(){}};
    }});
    const finished=engine.command({type:'start',requestId:1,input});
    try{
      await waitUntil(()=>messages.some(m=>m.type==='method-frame'&&m.t===input.snapshots),'fast side must progress independently');
      assert.deepEqual(messages.filter(m=>m.type==='method-frame').map(m=>[m.side,m.t]),[1,2,3].map(t=>[blockedSide==='echoSpline'?'guarded':'echoSpline',t]));
      assert.equal(messages.some(m=>m.type==='frame'||m.mode==='done'),false);
      fieldRelease.resolve();
      if(blockedSide==='guarded')await waitUntil(()=>messages.some(m=>m.field?.t===input.snapshots),'field must also finish');
      const early = messages.filter(m => m.field);
      assert.deepEqual(early.map(m => m.field.t), blockedSide === 'guarded' ? [1,2,3] : []);
      assert.ok(early.every(m => m.type === 'field-frame' && Number.isFinite(m.at)));
      const {scenario} = messages.find(m => m.type === 'prepared');
      for (const m of early) {
        assert.ok(messages.slice(0,messages.indexOf(m)+1).some(e=>e.type==='method-frame'&&e.side==='echoSpline'&&e.t===m.t));
        const expected = referenceDisplayFrame(scenario, m.field.grid, m.t);
        assert.deepEqual(m.field.Dbar, expected.Dbar);
        assert.deepEqual(m.field.betaHat, expected.betaHat);
      }
    }finally{fieldRelease.resolve();release.resolve();await finished;}
    assert.deepEqual(messages.filter(m=>m.type==='frame').map(m=>m.next),[1,2,3]);
    assert.equal(messages.at(-1).mode,'done');
  });
}

test('both estimators can finish while the first display field is blocked, then pause, step and resume in order', async () => {
  const messages = [], gate = Promise.withResolvers(), closed = [];
  const engine = createRunEngine({emit: m => messages.push(m),
    createMethod: side => ({step: () => ({candidates: [], curves: [], ms: 1}), close: () => closed.push(side)}),
    createFieldClient(grid, numerical) {
      const field = createDisplayField(grid, numerical);
      return {async step(wire) {
        if (wire.t === 1) await gate.promise;
        return field.step(wire);
      }, close: () => closed.push('field')};
    }});
  const finished = engine.command({type:'start', requestId:46, input});
  try {
    await waitUntil(() => messages.filter(m => m.type === 'method-frame').length === 2 * input.snapshots,
      'waiting for the field must not prevent either estimator from advancing');
    for (const side of ['echoSpline', 'guarded'])
      assert.deepEqual(messages.filter(m => m.side === side).map(m => m.t), [1, 2, 3]);
    assert.ok(!messages.some(m => m.field || m.type === 'frame' || m.mode === 'done'));
    engine.command({type:'pause',requestId:46});
  } finally { gate.resolve(); await finished; }
  assert.equal(messages.at(-1).mode, 'paused'); assert.equal(messages.at(-1).next, 1);
  await engine.command({type:'step',requestId:46});
  assert.equal(messages.at(-1).mode, 'paused'); assert.equal(messages.at(-1).next, 2);
  await engine.command({type:'resume',requestId:46});
  assert.equal(messages.at(-1).mode, 'done');
  const joined = messages.filter(m => m.type === 'frame');
  assert.deepEqual(joined.map(m => m.next), [1, 2, 3]);
  const {scenario} = messages.find(m => m.type === 'prepared');
  for (const m of joined) {
    for (const side of ['echoSpline', 'guarded'])
      assert.ok(messages.find(method => method.side === side && method.t === m.next).at <= m.fieldAt);
    const expected = referenceDisplayFrame(scenario, m.frame.grid, m.next);
    assert.deepEqual(m.frame.Dbar, expected.Dbar); assert.deepEqual(m.frame.betaHat, expected.betaHat);
  }
  assert.deepEqual(closed.sort(), ['echoSpline','field','guarded']);
});

for (const [mode,bounds] of [['viewport',[-4,27,-5,14]],['full field',undefined]]) test(
  `both estimators finish independently of ${mode} initialization and a pause releases that wait`, async () => {
  const fieldReady=Promise.withResolvers(), messages=[], processed=[], closed=[];
  const engine=createRunEngine({emit:m=>messages.push(m),
    createMethod:side=>({step:()=>({candidates:[],curves:[],ms:1}),close:()=>closed.push(side)}),
    createFieldClient:(grid,numerical)=>{
      const field=createDisplayField(grid,numerical);
      return {ready:fieldReady.promise,step(wire){processed.push(wire.t);return field.step(wire);},close:()=>closed.push('field')};
    }});
  const finished=engine.command({type:'start',requestId:145,input,...(bounds?{viewBounds:bounds}:{})});
  try {
    await waitUntil(()=>messages.filter(m=>m.type==='method-frame').length===2*input.snapshots,
      'both estimators must finish even while the display worker cannot initialize');
    assert.deepEqual(processed,[]);
    assert.ok(!messages.some(m=>m.field || m.type==='frame'));
    assert.deepEqual(messages.find(m=>m.type==='prepared').viewBounds,bounds);
    engine.command({type:'pause',requestId:145});
    await waitUntil(()=>messages.at(-1).mode==='paused','an uninitialized worker cannot hold a pause');
    assert.equal(messages.at(-1).next,0);
  } finally {fieldReady.resolve(); await finished;}
  await engine.command({type:'step',requestId:145});
  assert.equal(messages.at(-1).mode,'paused'); assert.deepEqual(processed,[1]);
  await engine.command({type:'resume',requestId:145});
  const scene=messages.find(m=>m.type==='prepared').scenario;
  const frames=messages.filter(m=>m.type==='frame');
  assert.deepEqual(frames.map(m=>m.next),[1,2,3]);
  for(const m of frames){
    const expected=referenceDisplayFrame(scene,m.frame.grid,m.next);
    assert.deepEqual(m.frame.Dbar,expected.Dbar);assert.deepEqual(m.frame.betaHat,expected.betaHat);
  }
  assert.equal(messages.at(-1).mode,'done'); assert.deepEqual(closed.sort(),['echoSpline','field','guarded']);
});

test('model loading overlaps bounded viewport work without publishing a future field or charging preparation to map clocks', async t => {
  const model=Promise.withResolvers(), right=Promise.withResolvers(), messages=[], fieldSteps=[];
  const settings={...input,snapshots:5}, scene=await generateScenario(settings), viewBounds=[-4,27,-5,14];
  let now=1000;
  t.mock.method(performance,'now',()=>now);
  const engine=createRunEngine({emit:m=>messages.push(m),prepare:async()=>scene,yieldTask:()=>Promise.resolve(),
    createMethod:side=>({ready:model.promise,async step(wire){
      if(side==='guarded'&&wire.t===1)await right.promise;
      now++;
      return {candidates:[],curves:[],ms:1};
    },close(){}}),
    createFieldClient:(grid,numerical)=>{
      const field=createDisplayField(grid,numerical);
      return {ready:Promise.resolve(),step(wire){fieldSteps.push(wire.t);now+=10;return field.step(wire);},close(){}};
    }});
  const finished=engine.command({type:'start',requestId:146,input:settings,viewBounds});
  try {
    await waitUntil(()=>fieldSteps.length===5,'all five small rasters fit while the model is loading');
    assert.deepEqual(fieldSteps,[1,2,3,4,5]);
    assert.ok(!messages.some(m=>m.type==='prepared'||m.type==='compute-clock'||m.type==='method-frame'||m.field||m.type==='frame'));
    now+=5000;model.resolve();
    await waitUntil(()=>messages.filter(m=>m.side==='echoSpline').length===5,'fast estimator should finish first');
    const left=messages.filter(m=>m.side==='echoSpline');
    assert.ok(left.every(m=>m.at>0&&m.at<100),'estimator clock excludes model loading and precomputed fields');
    for(const m of left)assert.equal(m.field.t,m.t);
    for(const [i,m] of messages.entries())if(m.field)
      assert.ok(messages.slice(0,i+1).some(e=>e.side==='echoSpline'&&e.t===m.field.t));
  } finally { model.resolve();right.resolve();await finished; }
  assert.deepEqual(fieldSteps,[1,2,3,4,5]);
  const joined=messages.filter(m=>m.type==='frame');
  assert.deepEqual(joined.map(m=>m.next),fieldSteps);
  assert.deepEqual(joined.map(m=>m.fieldAt),[0,0,0,0,0]);
  assert.equal(messages.at(-1).mode,'done');
});

test('the independent heatmap starts on measured prefixes and waits for the matching wall',async()=>{
  const scene=await generateScenario(input), steps=[], messages=[];
  const engine=createRunEngine({emit:m=>messages.push(m),
    prepare:async(_,progress,{onMeasured})=>{
      const wire=[];
      for(const sample of scene.wire){
        wire.push(sample);onMeasured(wire,scene.domain);
        await waitUntil(()=>steps.at(-1)===sample.t,'heatmap should run while later measurements are unavailable');
        assert.ok(!messages.some(m=>m.field || m.type==='prepared' || m.type==='frame'));
      }
      return scene;
    },
    createMethod:()=>({step:()=>({candidates:[],curves:[],ms:1}),close(){}}),
    createFieldClient:(grid,numerical)=>{
      const field=createDisplayField(grid,numerical);
      return {step(wire){steps.push(wire.t);return field.step(wire);},close(){}};
    }});
  await engine.command({type:'start',requestId:150,input,viewBounds:[-6,16,-3,15]});
  assert.deepEqual(steps,[1,2,3]);
  assert.deepEqual(messages.filter(m=>m.type==='frame').map(m=>m.fieldAt),[0,0,0]);
  assert.equal(messages.at(-1).mode,'done');
});

test('large camera rasters stop prefetching at the byte budget and resume with the walls',async()=>{
  const model=Promise.withResolvers(), steps=[], messages=[];
  const settings={...input,snapshots:6},scene=await generateScenario(settings);
  const raster=new Float32Array(256*1024); // 1 MiB for each of the two outputs.
  const engine=createRunEngine({emit:m=>messages.push(m),prepare:async()=>scene,
    createMethod:()=>({ready:model.promise,step:()=>({candidates:[],curves:[],ms:1}),close(){}}),
    createFieldClient:()=>({step({t}){steps.push(t);return {t,Dbar:raster,betaHat:raster};},close(){}})});
  const finished=engine.command({type:'start',requestId:151,input:settings,viewBounds:[-6,16,-3,15]});
  try {
    await waitUntil(()=>steps.length>=4,'four prefetched rasters fit');
    assert.deepEqual(steps,[1,2,3,4]);
  } finally {model.resolve();await finished;}
  const joined=messages.filter(m=>m.type==='frame');
  assert.deepEqual(joined.map(m=>m.next),[1,2,3,4,5,6]);
  assert.equal(joined.filter(m=>m.fieldAt===0).length,4);
});

test('obsolete viewport readiness cannot emit a field or fail a replacement run', async () => {
  const gate=Promise.withResolvers(), replacementReady=Promise.withResolvers(), messages=[], closed=[];
  let generation=0;
  const engine=createRunEngine({emit:m=>messages.push(m),
    createMethod:side=>({step:()=>({candidates:[],curves:[],ms:1}),close:()=>closed.push(side)}),
    createFieldClient:(grid,numerical)=>{
      if(++generation===1)return {ready:gate.promise,step:()=>assert.fail('obsolete field was stepped'),close:()=>closed.push('field')};
      const field=createDisplayField(grid,numerical);
      return {ready:replacementReady.promise,step:wire=>field.step(wire),close:()=>closed.push('field')};
    }});
  const viewBounds=[-6,16,-3,15];
  const finished=engine.command({type:'start',requestId:147,input,viewBounds});
  await waitUntil(()=>messages.some(m=>m.side==='echoSpline'),'method should start without viewport');
  engine.command({type:'cancel',requestId:147}); await finished;
  assert.equal(messages.at(-1).mode,'cancelled');
  assert.deepEqual(closed.sort(),['echoSpline','field','guarded']);
  const cancelledCount=messages.length;
  const replaced=engine.command({type:'start',requestId:148,input,viewBounds});
  try {
    await waitUntil(()=>messages.some(m=>m.requestId===148 && m.side==='echoSpline'),'replacement estimator should already be running');
    gate.reject(new Error('late viewport initialization')); await delay(0);
    assert.equal(messages.filter(m=>m.requestId===147).length,cancelledCount);
  } finally { replacementReady.resolve(); await replaced; }
  assert.ok(!messages.some(m=>m.type==='error'));assert.equal(messages.at(-1).mode,'done');
});

test('pausing a viewport prefetch keeps its in-flight prefix and a single step consumes it only once', async () => {
  const models=Promise.withResolvers(), firstField=Promise.withResolvers(), messages=[], steps=[];
  const engine=createRunEngine({emit:m=>messages.push(m),
    createMethod:()=>({ready:models.promise,step:()=>({candidates:[],curves:[],ms:1}),close(){}}),
    createFieldClient:(grid,numerical)=>{
      const field=createDisplayField(grid,numerical);
      return {async step(wire){steps.push(wire.t);if(wire.t===1)await firstField.promise;return field.step(wire);},close(){}};
    }});
  const started=engine.command({type:'start',requestId:149,input,viewBounds:[-6,16,-3,15]});
  try {
    await waitUntil(()=>steps.length===1,'an early prefix step should be executing');
    engine.command({type:'pause',requestId:149}); models.resolve();
    await waitUntil(()=>messages.some(m=>m.type==='prepared'),'models should initialize while the field step is pending');
    assert.ok(!messages.some(m=>m.type==='method-frame'||m.type==='frame'||m.mode==='paused'));
  } finally { models.resolve();firstField.resolve();await started; }
  assert.equal(messages.at(-1).mode,'paused');assert.equal(messages.at(-1).next,0);
  await engine.command({type:'step',requestId:149});
  assert.equal(messages.at(-1).mode,'paused');assert.equal(messages.at(-1).next,1);
  assert.deepEqual(steps,[1]);
  await engine.command({type:'resume',requestId:149});
  assert.deepEqual(steps,[1,2,3]);assert.equal(messages.at(-1).mode,'done');
});

test('only the field parks when its next four rasters are ready, and pause releases it',async()=>{
  const wall=Promise.withResolvers(),steps=[],messages=[], settings={...input,snapshots:8};
  const scene=await generateScenario(settings);
  const engine=createRunEngine({emit:m=>messages.push(m),prepare:async()=>scene,
    createMethod:side=>({async step(wire){
      if(side==='echoSpline' && wire.t===1)await wall.promise;
      return {candidates:[],curves:[],ms:1};
    },close(){}}),
    createFieldClient:(grid,numerical)=>{
      const field=createDisplayField(grid,numerical);
      return {step(wire){steps.push(wire.t);return field.step(wire);},close(){}};
    }});
  const finished=engine.command({type:'start',requestId:152,input:settings,viewBounds:[-6,16,-3,15]});
  try {
    await waitUntil(()=>steps.length>=4 && messages.filter(m=>m.side==='guarded').length===8,'right wall continues while the field parks');
    assert.deepEqual(steps,[1,2,3,4]);
    engine.command({type:'pause',requestId:152});
  } finally {wall.resolve();await finished;}
  assert.equal(messages.at(-1).mode,'paused');
  assert.deepEqual(steps,[1,2,3,4]);
  await engine.command({type:'resume',requestId:152});
  assert.deepEqual(steps,[1,2,3,4,5,6,7,8]);
  assert.equal(messages.at(-1).mode,'done');
});

test('a field that finishes before both estimators first appears with its matching EchoSpline snapshot', async () => {
  const gates = {echoSpline:Promise.withResolvers(), guarded:Promise.withResolvers()}, messages = [];
  let latestField = 0;
  const engine = createRunEngine({emit: m => messages.push(m),
    createMethod: side => ({async step(wire) {
      if (wire.t === 1) await gates[side].promise;
      return {candidates:[], curves:[], ms:1};
    }, close(){}}),
    createFieldClient(grid,numerical) {
      const field = createDisplayField(grid,numerical);
      return {step(wire){latestField = wire.t; return field.step(wire);}, close(){}};
    }});
  const finished = engine.command({type:'start',requestId:47,input});
  try {
    await waitUntil(() => latestField === input.snapshots, 'the display worker may finish first');
    assert.ok(!messages.some(m => m.field || m.type === 'frame'));
    gates.echoSpline.resolve();
    await waitUntil(() => messages.filter(m => m.side === 'echoSpline').length === 3, 'left estimator should finish');
    assert.deepEqual(messages.filter(m => m.field).map(m => [m.type,m.t,m.field.t]),
      [1,2,3].map(t => ['method-frame',t,t]));
  } finally {
    gates.echoSpline.resolve(); gates.guarded.resolve(); await finished;
  }
  for (const m of messages.filter(m => m.type === 'frame'))
    assert.ok(m.fieldAt <= messages.find(method => method.side === 'echoSpline' && method.t === m.next).at);
});

for (const stop of ['cancel','fail']) {
  test(`a pending field can ${stop} without leaking workers or sending stale frames`, async () => {
    const gate = Promise.withResolvers(), messages = [], closed = [];
    let fieldStarted = false;
    const engine = createRunEngine({emit:m=>messages.push(m),
      createMethod:side=>({step:()=>({candidates:[],curves:[],ms:1}),close:()=>closed.push(side)}),
      createFieldClient:()=>({step(){fieldStarted=true; return gate.promise;}, close:()=>closed.push('field')})});
    const finished = engine.command({type:'start', requestId:48, input});
    try {
      await waitUntil(()=>fieldStarted,'first field request not issued');
      if (stop === 'cancel') engine.command({type:'cancel', requestId:48});
    } finally {
      gate.reject(new Error('display worker stopped')); await finished;
    }
    assert.deepEqual(closed.sort(), ['echoSpline','field','guarded']);
    assert.ok(!messages.some(m => m.type === 'frame' || m.mode === 'done'));
    if (stop === 'cancel') {
      assert.equal(messages.at(-1).mode,'cancelled');
      assert.ok(!messages.some(m=>m.type==='error'));
    } else assert.deepEqual(messages.at(-1),{type:'error',requestId:48,message:'display worker stopped'});
  });
}

test('independent learned estimators produce the same prefix outputs as a joint comparison',async()=>{
  const scene=await generateScenario({...input,scene:'paper-upper',seed:3296639392,snapshots:16});
  for(const rightMethod of ['spline-cnn','spline-cnn-fast','gbdt','gat','arc']){
    const settings={...scene.input,rightMethod},joint=new EchoComparison(settings,scene.domain),
      left=new EchoComparison(settings,scene.domain,'echoSpline'),right=new EchoComparison(settings,scene.domain,'guarded');
    await Promise.all([joint.loadModel(),right.loadModel({useGpu:rightMethod==='arc'})]);
    for(const wire of scene.wire){
      const reference=joint.step(wire);
      assert.deepEqual(numerical(left.stepLeft(wire)),numerical(reference.echoSpline));
      const {stageTotalsMs,backend,gpuCalls,gpuAdapter,gpuMode,gpuReadbacks,gpuCompact,gpuInputBytes,gpuOutputBytes,gpuOverflowReadbacks,...single}=await right.stepSide('guarded',wire);
      if(rightMethod==='arc'){
        assert.ok(backend==='CPU WASM'||backend==='WebGPU + CPU');
        assert.equal(typeof gpuAdapter,'string');
        if(backend==='WebGPU + CPU')assert.ok(gpuCalls>0);
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
    fallback.close();assert.throws(()=>make('invalid'),/device/);
  }finally{
    if(previous)Object.defineProperty(navigator,'gpu',previous);
    else delete navigator.gpu;
  }
});
