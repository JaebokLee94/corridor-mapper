import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkCases, benchmarkPlan, compareWallOutputs, startDeviceBenchmark, expectedGpuStages, benchmarkDisplayRows, summarizeDeviceTrials, sampleBenchmarkFrames } from '../../drf/device-benchmark.mjs';

const base = {scene:'paper-upper',wallSide:'upper',vehicles:3,snapshots:2,seed:538772167};
const scene = {domain:[0,100,-20,50],wire:[{t:1,configs:[]},{t:2,configs:[]}],truth:[],walls:[]};
const evaluator = () => ({step:() => ({interpolation:{rawMap:{mapF1:.8}}})});
function fixture({gpuOffset = 0, gpuActive = true} = {}) {
  let live = 0, maximum = 0;
  const calls = [];
  return { calls, get maximum(){ return maximum; }, makeMethod(method,input,domain) {
    assert.equal(Object.hasOwn(input,'truth'),false); assert.equal(Object.hasOwn(input,'wires'),false);
    assert.deepEqual(domain,scene.domain);
    live++; maximum = Math.max(maximum,live);
    const gpu = input.computeDevice === 'gpu', device = {requested:input.computeDevice,splineGpu:gpu&&gpuActive,neuralGpu:false,densityGpu:false}, row = { method, input, prefixes:[] }; calls.push(row);
    let closed = false;
    return {ready:Promise.resolve(device), async step(wire) {
      row.prefixes.push(wire.t);
      return {device,ms:gpu?2:4,candidates:[],curves:[[[0,gpu?gpuOffset:0],[1,1]]],backend:gpu&&gpuActive?'WebGPU + CPU':'CPU',gpuCalls:gpu&&gpuActive?wire.t:0};
    },close(){if(!closed){live--;closed=true;}}};
  }};
}

test('matrix freezes seed/duration, crosses 3/10 and simple/rugged, and rotates measured device order', () => {
  const cases = benchmarkCases(base,'matrix');
  assert.deepEqual(cases.map(c=>[c.id,c.input.vehicles,c.input.seed,c.input.snapshots]),[
    ['simple-3',3,538772167,2],['simple-10',10,538772167,2],['rugged-3',3,538772167,2],['rugged-10',10,538772167,2]]);
  const plan = benchmarkPlan(['echoSpline','spline-cnn'],3,true);
  assert.equal(plan.length,20);
  assert.deepEqual(plan.filter(p=>p.method==='spline-cnn'&&p.round===1).map(p=>p.variant.id),['gpu','neural-gpu','cpu']);
  assert.deepEqual(plan.find(p=>p.variant.id==='neural-gpu').variant,{id:'neural-gpu',computeDevice:'gpu',echoBackend:'cpu'});
});

test('full production-style prefixes are serial, no truth reaches an estimator, and every output is compared', async () => {
  const f = fixture();
  const record = await startDeviceBenchmark({cases:benchmarkCases(base),methods:['echoSpline'],repeats:3,warmup:true,
    prepare:async()=>scene,makeMethod:f.makeMethod,makeEvaluator:evaluator,page:undefined}).promise;
  assert.equal(record.status,'complete'); assert.equal(f.maximum,1); assert.equal(f.calls.length,8);
  assert.ok(f.calls.every(c=>JSON.stringify(c.prefixes)==='[1,2]'));
  assert.equal(record.cases[0].wireSha256.length,64);
  assert.ok(record.trials.every(t=>t.outputExact&&t.admissible));
  assert.deepEqual(record.summary.map(s=>[s.device,s.n,s.medianMs]),[['cpu',3,8],['gpu',3,4]]);
  assert.equal(record.trials.filter(t=>t.frames).length,2);
  assert.ok(record.trials.every(t=>t.rows.every(r=>r.outputSha256.length===64&&r.parity.exact)));
});

test('GPU wall displacement above 2 mm is retained and rejected before measured repetitions', async () => {
  const f = fixture({gpuOffset:.003});
  const record = await startDeviceBenchmark({cases:benchmarkCases(base),methods:['echoSpline'],repeats:3,warmup:true,
    prepare:async()=>scene,makeMethod:f.makeMethod,makeEvaluator:evaluator,page:undefined}).promise;
  assert.equal(f.calls.filter(c=>c.input.computeDevice==='gpu').length,1);
  const failed = record.trials.find(t=>t.variant.id==='gpu'&&t.status==='complete');
  assert.equal(failed.admissible,false); assert.equal(failed.maxVertexDistanceM,.003); assert.equal(failed.frames.length,2);
  assert.equal(record.trials.filter(t=>t.status==='skipped').length,3);
  assert.deepEqual(record.summary.map(s=>s.device),['cpu']);
});

test('GPU fallback is not reported as GPU speed, and a small curve difference remains explicit', async () => {
  const f = fixture({gpuActive:false});
  const record = await startDeviceBenchmark({cases:benchmarkCases(base),methods:['echoSpline'],repeats:1,warmup:false,
    prepare:async()=>scene,makeMethod:f.makeMethod,makeEvaluator:evaluator,page:undefined}).promise;
  assert.equal(record.summary.some(s=>s.device==='gpu'),false);
  assert.equal(record.trials.find(t=>t.variant.id==='gpu').status,'unavailable');
  const p = compareWallOutputs({curves:[[[0,.001]]]}, {curves:[[[0,0]]]});
  assert.equal(p.exact,false); assert.equal(p.sameCurveShape,true); assert.equal(p.maxVertexDistanceM,.001);
});


test('requested GPU stages and fallback errors are checked throughout each prefix', async () => {
  assert.deepEqual(expectedGpuStages('spline-cnn','gpu'),['splineGpu','neuralGpu']);
  assert.deepEqual(expectedGpuStages('spline-cnn','neural-gpu'),['neuralGpu']);
  assert.deepEqual(expectedGpuStages('wmp','gpu'),['densityGpu']);
  const f = fixture();
  const method = (id,input,domain) => {
    const client = f.makeMethod(id,input,domain), step = client.step;
    client.step = async wire => {
      const result = await step(wire);
      if(input.computeDevice === 'gpu' && wire.t === 2) result.device = {...result.device,fallbackReason:'lost device'};
      return result;
    };
    return client;
  };
  const record = await startDeviceBenchmark({cases:benchmarkCases(base),methods:['echoSpline'],repeats:3,warmup:true,
    prepare:async()=>scene,makeMethod:method,makeEvaluator:evaluator,page:undefined}).promise;
  const failed = record.trials.find(t=>t.variant.id==='gpu');
  assert.equal(failed.status,'unavailable'); assert.match(failed.error,/lost device/); assert.equal(failed.frames.length,2);
  assert.equal(record.summary.some(t=>t.device==='gpu'),false);
});

test('a hidden trial is kept as invalid, retries after visibility, and cancellation terminates its worker', async () => {
  const page = new EventTarget(); page.hidden = false; page.visibilityState = 'visible';
  const f = fixture(); let hiddenOnce = false;
  const record = await startDeviceBenchmark({cases:benchmarkCases(base),methods:['echoSpline'],repeats:1,warmup:false,
    prepare:async()=>scene,makeMethod:f.makeMethod,makeEvaluator:evaluator,page,
    onProgress:event=>{
      if(event.snapshot === 1 && !hiddenOnce){
        hiddenOnce = true; page.hidden = true; page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'));
        queueMicrotask(()=>{page.hidden = false; page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'));});
      }
    }}).promise;
  assert.equal(record.trials[0].status,'hidden'); assert.equal(record.trials[1].attempt,2);
  assert.equal(record.trials[1].status,'complete'); assert.equal(f.maximum,1);
  let handle;
  handle = startDeviceBenchmark({cases:benchmarkCases(base),methods:['echoSpline'],repeats:3,warmup:true,
    prepare:async()=>scene,makeMethod:f.makeMethod,makeEvaluator:evaluator,page,
    onProgress:event=>{if(event.snapshot === 1)handle.cancel();}});
  assert.equal((await handle.promise).status,'cancelled');
});


test('quadratic patch displacement bounds reproduce known translation and curvature changes', () => {
  const patch = {id:'1h',center:[0,0],phi:0,kappa:0,sg:1,ell:2,status:'supported'};
  const translation = compareWallOutputs({candidates:[{...patch,center:[3,4]}]}, {candidates:[patch]});
  assert.equal(translation.maxCandidatePatchDisplacementBoundM,5);
  assert.equal(translation.discreteOutputChanges,0);
  const bending = compareWallOutputs({candidates:[{...patch,kappa:1,status:'pending'}]}, {candidates:[patch]});
  assert.equal(bending.maxCandidatePatchDisplacementBoundM,2);
  assert.equal(bending.discreteOutputChanges,1);
  assert.equal(bending.exact,false);
  const missing = compareWallOutputs({candidates:[]},{candidates:[patch]});
  assert.equal(missing.unmatchedCandidates,1); assert.equal(missing.discreteOutputChanges,1);
});

test('display rows retain rejected warm-ups without mixing their durations into measured summaries', () => {
  const record = {summary:[{caseId:'simple-3',method:'wmp',device:'cpu',n:3,medianMs:20}],trials:[
    {caseId:'simple-3',method:'wmp',variant:{id:'gpu'},stage:'warmup',status:'complete',rejection:'Output parity tolerance exceeded',totalMs:10,rows:[{mapF1:.8}],maxCandidatePatchDisplacementBoundM:1.4,discreteOutputChanges:86},
    {caseId:'simple-3',method:'wmp',variant:{id:'gpu'},stage:'measured',status:'skipped',reason:'Output parity tolerance exceeded'},
    {caseId:'simple-3',method:'gat',variant:{id:'gpu'},stage:'warmup',status:'unavailable',error:'GPU calibration failed',rows:[]},
  ]};
  const rows = benchmarkDisplayRows(record);
  assert.equal(rows.length,3); assert.equal(record.summary.length,1);
  assert.equal(rows[1].n,0); assert.equal(rows[1].timingStage,'warm-up'); assert.equal(rows[1].diagnosticMs,10);
  assert.equal(rows[1].medianMs,undefined); assert.equal(rows[1].discreteOutputChanges,86);
  assert.equal(rows[2].diagnosticMs,null); assert.equal(rows[2].excludedReason,'GPU calibration failed');
});


test('initialization-only worker failures retry twice at most and preserve failed attempts', async () => {
  const f = fixture(); let attempts = 0;
  const makeMethod = (method,input,domain) => {
    attempts++;
    if(attempts <= 2) return {ready:Promise.reject(new Error('Estimator worker failed')),close(){}};
    return f.makeMethod(method,input,domain);
  };
  const record = await startDeviceBenchmark({cases:benchmarkCases(base),methods:['echoSpline'],repeats:1,warmup:false,
    prepare:async()=>scene,makeMethod,makeEvaluator:evaluator,page:undefined}).promise;
  assert.equal(record.status,'complete'); assert.equal(attempts,4);
  assert.deepEqual(record.trials.slice(0,3).map(t=>[t.status,t.attempt,t.retryableInitialization]),[
    ['failed',1,true],['failed',2,true],['complete',3,false]]);
  assert.ok(record.summary.every(s=>s.admissible));
});

test('persistent CPU initialization failure stops before GPU comparisons', async () => {
  let attempts = 0;
  const record = await startDeviceBenchmark({cases:benchmarkCases(base),methods:['echoSpline'],repeats:3,warmup:true,
    prepare:async()=>scene,makeMethod:(method,input)=>{
      assert.equal(input.computeDevice,'cpu'); attempts++;
      return {ready:Promise.reject(new Error('Estimator worker failed')),close(){}};
    },makeEvaluator:evaluator,page:undefined}).promise;
  assert.equal(record.status,'failed'); assert.equal(attempts,3);
  assert.match(record.error,/CPU reference failed.*3 attempt.*stopped before GPU/);
  assert.equal(record.trials.length,3); assert.equal(record.summary.length,0);
  assert.equal(record.trials[2].retryExhausted,true);
});

test('worker failure after initialization is not retried and failed candidates cannot win', async () => {
  let attempts = 0;
  const record = await startDeviceBenchmark({cases:benchmarkCases(base),methods:['echoSpline'],repeats:3,warmup:true,
    prepare:async()=>scene,makeMethod:()=>{
      attempts++;
      return {ready:Promise.resolve({requested:'cpu'}),step:async()=>{throw new Error('Estimator worker failed');},close(){}};
    },makeEvaluator:evaluator,page:undefined}).promise;
  assert.equal(record.status,'failed'); assert.equal(attempts,1);
  assert.equal(record.trials[0].retryableInitialization,false);
  const good = {caseId:'current',method:'echoSpline',variant:{id:'gpu'},stage:'measured',status:'complete',
    totalMs:1,rows:[{ms:1,mapF1:.8}],admissible:true,backendVerified:true,outputExact:true};
  const summary = summarizeDeviceTrials([good,{...good,status:'failed',error:'Inference failed',initialized:{},rows:[]}]);
  assert.equal(summary[0].admissible,false); assert.equal(summary[0].excludedReason,'Inference failed');
});

test('progress saves omit large arrays while the final save retains measurements, all rows and representative outputs', async t => {
  const posts = [], source = {revision:'test-revision',dirtySourceHash:'fixed-source'}, f = fixture();
  t.mock.method(globalThis,'fetch',async (url,options) => {
    if(url === '/__benchmark/source') return new Response(JSON.stringify(source));
    assert.equal(url,'/__benchmark/result'); assert.equal(options.method,'POST');
    posts.push({payload:JSON.parse(options.body),bytes:Buffer.byteLength(options.body)});
    return new Response('{}');
  });
  const record = await startDeviceBenchmark({cases:benchmarkCases(base),methods:['echoSpline'],repeats:1,warmup:false,
    prepare:async()=>scene,makeMethod:f.makeMethod,makeEvaluator:evaluator,page:undefined,localSave:true}).promise;
  assert.equal(record.status,'complete'); assert.equal(record.saveError,undefined);
  const progress = posts.slice(0,-1), final = posts.at(-1);
  assert.equal(progress.length,2);
  for(const post of progress){
    assert.equal(post.payload.recordMode,'progress');
    assert.ok(post.payload.cases.every(c=>!Object.hasOwn(c,'wires')&&!Object.hasOwn(c,'evaluationTruth')));
    assert.ok(post.payload.trials.every(run=>!Object.hasOwn(run,'frames')&&!Object.hasOwn(run,'rows')));
    assert.ok(post.bytes < final.bytes);
  }
  assert.equal(final.payload.recordMode,undefined); assert.equal(record.recordMode,undefined);
  assert.equal(final.payload.status,'complete'); assert.deepEqual(final.payload.cases[0].wires,scene.wire);
  assert.deepEqual(final.payload.cases[0].evaluationTruth.truth,scene.truth);
  assert.deepEqual(final.payload.trials.map(run=>run.rows),record.trials.map(run=>run.rows));
  assert.deepEqual(final.payload.trials.map(run=>run.frames),record.trials.map(run=>run.frames));
  assert.ok(final.payload.trials.every(run=>run.rows.length===2&&run.frames.length===2));
});


test('100-prefix geometry samples preserve endpoints, first difference and both interior maximum-error frames', () => {
  const frames = Object.freeze(Array.from({length:100},(_,i)=>({t:i+1,curves:[[[i,0]]]})));
  const differences = Array.from({length:100},()=>({exact:true,maxVertexDistanceM:0,maxCandidatePatchDisplacementBoundM:0}));
  differences[17] = {...differences[17],exact:false,maxVertexDistanceM:.001};
  differences[52] = {...differences[52],exact:false,maxVertexDistanceM:.005};
  differences[71] = {...differences[71],exact:false,maxCandidatePatchDisplacementBoundM:1.6};
  const sampled = sampleBenchmarkFrames(frames,Object.freeze(differences));
  assert.deepEqual(sampled.frameIndices,[0,17,52,71,99]);
  assert.deepEqual(sampled.frames,sampled.frameIndices.map(i=>frames[i]));
  assert.equal(frames.length,100); assert.equal(differences.length,100);
  const tied = Array.from({length:100},()=>({exact:true,maxVertexDistanceM:0,maxCandidatePatchDisplacementBoundM:0}));
  tied[37] = {exact:false,maxVertexDistanceM:1,maxCandidatePatchDisplacementBoundM:2};
  assert.deepEqual(sampleBenchmarkFrames(frames,tied).frameIndices,[0,37,99]);
  assert.deepEqual(sampleBenchmarkFrames(frames).frameIndices,[0,99]);
  assert.deepEqual(sampleBenchmarkFrames([]),{frames:[],frameIndices:[]});
  assert.deepEqual(sampleBenchmarkFrames([frames[0]]).frameIndices,[0]);
});

test('retaining representative geometry does not shorten the 100-prefix timing and parity records', async () => {
  const f = fixture(), longScene = {...scene,wire:Array.from({length:100},(_,i)=>({t:i+1,configs:[]}))};
  const record = await startDeviceBenchmark({cases:benchmarkCases({...base,snapshots:100}),methods:['echoSpline'],repeats:1,warmup:false,
    prepare:async()=>longScene,makeMethod:f.makeMethod,makeEvaluator:evaluator,page:undefined}).promise;
  assert.equal(record.status,'complete'); assert.equal(record.trials.length,2);
  for(const run of record.trials){
    assert.equal(run.rows.length,100); assert.deepEqual(run.rows.map(r=>r.t),Array.from({length:100},(_,i)=>i+1));
    assert.ok(run.rows.every(row=>row.outputSha256.length===64&&row.parity.exact));
    assert.deepEqual(run.frameIndices,[0,99]); assert.equal(run.frames.length,2);
  }
  assert.equal(record.summary.find(s=>s.device==='cpu').medianMs,400);
  assert.equal(record.summary.find(s=>s.device==='gpu').medianMs,200);
});
