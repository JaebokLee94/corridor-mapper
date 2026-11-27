import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createGrid, createField } from '../../drf/field.mjs';
import { createViewportReadout } from '../../drf/viewport-readout.mjs';

const baseGrid = createGrid(10, 10, [-.5, 9.5, -.5, 9.5]);
const bounds = [-4.8, 15.1, -.22, 7];
const input = () => ({baseGrid, bounds, numerical:{band:3, perimeter:'ramanujan'},
  wire:[1,2,3,4].map(t => ({t, configs:[]})), t:2});
const tick = () => new Promise(resolve => setImmediate(resolve));
const frameFor=t=>({t,Q:t,Dbar:Float32Array.of(t),betaHat:Float32Array.of(1/t)});
function settleBatch(request,makeFrame=frameFor) {
  const {t,readFrom}=request.message;
  const frames=Array.from({length:t-readFrom+1},(_,i)=>makeFrame(readFrom+i));
  request.resolve({type:'displayBatch',t,frames});
  return frames;
}

function harness() {
  const workers = [], errors = [];
  let redraws = 0;
  const reader = createViewportReadout(() => {
    const handle = {pending:[], stopped:0,
      request(message) { return new Promise((resolve, reject) => handle.pending.push({message, resolve, reject})); },
      stop() { handle.stopped++; }};
    workers.push(handle);
    return handle;
  }, () => redraws++, error => errors.push(error.message));
  return {reader, workers, errors, redraws:() => redraws};
}

test('reads ordered measured prefixes, caches backwards seeks and reuses equivalent camera cells', async () => {
  const {reader, workers, errors, redraws} = harness(), run = input();
  Object.defineProperty(run.wire, 3, {get() { throw new Error('future wire accessed'); }});
  assert.equal(reader.read(run), undefined);
  assert.equal(reader.read({...run, bounds:[-4.7, 15.2, -.13, 7.1]}), undefined);
  const worker = workers[0];
  assert.equal(workers.length, 1); assert.equal(worker.pending.length, 1);
  const init = worker.pending[0];
  assert.deepEqual(init.message, {type:'initDisplay', grid:{nx:10, ny:10, domain:baseGrid.domain},
    numerical:{band:3, perimeter:'ramanujan', viewBounds:[-5.5, 15.5, -.5, 7.5]}});
  init.resolve({type:'initialized',grid:baseGrid}); await tick();
  assert.deepEqual(worker.pending[1].message, {type:'displayBatch',t:2,readFrom:1,snapshots:run.wire.slice(0,2)});
  assert.equal(reader.read({...run, t:3}), undefined);
  assert.equal(worker.pending.length, 2);
  settleBatch(worker.pending[1]); await tick();
  assert.equal(redraws(), 0);
  assert.deepEqual(worker.pending[2].message, {type:'displayBatch',t:3,readFrom:3,snapshots:[run.wire[2]]});
  const historical = reader.read({...run, t:1});
  assert.deepEqual(historical, {...frameFor(1),grid:baseGrid});
  settleBatch(worker.pending[2]); await tick();
  assert.equal(worker.pending.length, 3, 'a backward seek stops further stepping');
  assert.equal(redraws(), 0);
  assert.equal(reader.read({...run,t:1}), historical);
  assert.deepEqual(reader.read(run), {...frameFor(2),grid:baseGrid});
  assert.deepEqual(reader.read({...run,t:3}), {...frameFor(3),grid:baseGrid});
  assert.equal(redraws(), 0); assert.deepEqual(errors, []);
  reader.reset();
  assert.equal(worker.stopped, 1);
});

test('changing cells or runs and resetting fence old initializations, results and errors', async () => {
  const {reader, workers, errors, redraws} = harness(), run = input();
  reader.read(run);
  const panned = {...run, bounds:[-20, -15, -2, -1]};
  reader.read(panned);
  workers[0].pending[0].resolve({type:'initialized'}); await tick();
  assert.equal(workers[0].stopped, 1); assert.equal(workers[0].pending.length, 1);
  workers[1].pending[0].resolve({type:'initialized'}); await tick();
  const otherRun = {...panned, wire:run.wire.slice(), t:1};
  reader.read(otherRun);
  workers[1].pending[1].reject(new Error('old pan failed')); await tick();
  assert.equal(workers[1].stopped, 1); assert.deepEqual(errors, []);
  workers[2].pending[0].resolve({type:'initialized'}); await tick();
  reader.reset();
  settleBatch(workers[2].pending[1]); await tick();
  assert.equal(redraws(), 0); assert.deepEqual(errors, []);
  assert.equal(reader.read(otherRun), undefined);
  assert.equal(workers.length, 4);
  reader.read({...otherRun, wire:[], t:0});
  assert.equal(workers[3].stopped, 1);
});

test('current worker and input errors are reported once and corrected views can restart', async () => {
  const {reader, workers, errors} = harness(), run = input();
  const invalid = {...run, bounds:[1, 0, 1, 2]};
  reader.read(invalid); reader.read(invalid);
  assert.equal(errors.length, 1); assert.match(errors[0], /viewBounds/); assert.equal(workers.length, 0);
  reader.read(run);
  workers[0].pending[0].reject(new Error('worker initialization failed')); await tick();
  reader.read(run); reader.read(run);
  assert.equal(workers.length, 1); assert.equal(workers[0].stopped, 1);
  assert.equal(errors[1], 'worker initialization failed'); assert.equal(errors.length, 2);
  reader.read({...run, numerical:{band:'full'}});
  assert.equal(workers.length, 2);
  workers[1].pending[0].resolve({type:'initialized'}); await tick();
  workers[1].pending[1].resolve({type:'frame', t:2}); await tick();
  assert.match(errors[2], /unexpected viewport snapshot/);
  reader.reset(); assert.equal(workers[1].stopped, 1);
});

test('a long seek batches only measured prefixes, returns its scrubbing neighbors, and catches a moving target', async()=>{
  const {reader,workers,errors,redraws}=harness();
  const wire=Array.from({length:100},(_,i)=>({t:i+1,configs:[]}));
  const run={...input(),wire,t:87};
  reader.read(run);
  workers[0].pending[0].resolve({type:'initialized',grid:baseGrid});await tick();
  let received=[],rasters=[],count=0;
  while(!reader.read({...run,t:100})){
    const request=workers[0].pending[++count];
    assert.ok(request);assert.ok(request.message.snapshots.length<=8);
    received.push(...request.message.snapshots.map(s=>s.t));
    rasters.push(...settleBatch(request).map(f=>f.t));await tick();
  }
  assert.equal(count,13);assert.equal(workers.length,1);assert.equal(redraws(),1);
  assert.deepEqual(received,wire.map(s=>s.t));assert.deepEqual(rasters,[97,98,99,100]);
  const last=reader.read({...run,t:100});
  assert.equal(reader.read({...run,t:99}).grid,last.grid);assert.equal(workers.length,1);
  assert.equal(reader.read({...run,t:21}),undefined);assert.equal(workers[0].stopped,1);
  const worker=workers[1];worker.pending[0].resolve({type:'initialized',grid:baseGrid});await tick();
  for(let i=1;i<=3;i++) {settleBatch(worker.pending[i]);await tick();}
  assert.equal(reader.read({...run,t:21}).t,21);
  assert.equal(reader.read({...run,t:100}),last,'cached forward seeks retain their exact field');
  assert.equal(redraws(),2);assert.deepEqual(errors,[]);
  reader.reset();
});

test('the raster cache evicts older byte-heavy readouts and still returns the requested field', async()=>{
  const {reader,workers}=harness(), run=input();
  reader.read(run);
  const worker=workers[0];worker.pending[0].resolve({type:'initialized',grid:baseGrid});await tick();
  settleBatch(worker.pending[1],t=>({t,Dbar:{byteLength:6*1024*1024},betaHat:{byteLength:6*1024*1024}}));await tick();
  assert.equal(reader.read(run).t,2);
  assert.equal(reader.read({...run,t:1}),undefined);assert.equal(workers[0].stopped,1);
  assert.equal(workers.length,2);reader.reset();
});

test('the actual field worker transfers only requested readouts, with the exact cumulative values after skipped frames', async context=>{
  const url=new URL('../../drf/field.worker.mjs',import.meta.url).href;
  const worker=new Worker(`
    const {parentPort}=require('node:worker_threads');
    globalThis.postMessage=(response,transfer)=>parentPort.postMessage(response,transfer);
    import(${JSON.stringify(url)}).then(()=>parentPort.on('message',data=>globalThis.onmessage({data})));
  `,{eval:true});
  context.after(()=>worker.terminate());
  let id=0;
  async function request(message){
    const response=once(worker,'message');
    worker.postMessage({...message,requestId:++id});return (await response)[0];
  }
  const init=await request({type:'initDisplay',grid:baseGrid,numerical:{viewBounds:bounds}});
  assert.equal(init.type,'initialized');
  const field=createField(init.grid);
  const snapshots=Array.from({length:11},(_,i)=>({t:i+1,configs:[{
    i:0,j:1,pHat_i:[i/4,2],pHat_j:[4,3],Sigma_i:[0,0,0],Sigma_j:[0,0,0],paths:[{dHat:10+i/5,sigmaD:.4}],
  }]}));
  const expected=snapshots.map(wire=>field.step(wire));
  const hidden=await request({type:'displayBatch',snapshots:snapshots.slice(0,8),t:8,readFrom:9});
  assert.equal(hidden.type,'displayBatch');assert.equal(hidden.t,8);assert.deepEqual(hidden.frames,[]);
  const shown=await request({type:'displayBatch',snapshots:snapshots.slice(8,10),t:10,readFrom:9});
  assert.deepEqual(shown.frames.map(f=>f.t),[9,10]);
  for(const actual of shown.frames) {
    for(const key of ['Dbar','betaHat','Q','epsilonA','admitted','rejected'])
      assert.deepEqual(actual[key],expected[actual.t-1][key],key);
    assert.equal(Object.hasOwn(actual,'grid'),false);
  }
  const extra=await request({type:'displayBatch',snapshots:[snapshots[10],{t:12,configs:[]}],t:11,readFrom:11});
  assert.equal(extra.type,'error');assert.match(extra.error,/requested prefix/);
  const last=await request({type:'displayBatch',snapshots:[snapshots[10]],t:11,readFrom:11});
  assert.deepEqual(last.frames[0].Dbar,expected[10].Dbar);
  // Malformed numerical input midway through a batch invalidates only this accumulator.
  const bad={t:13,configs:[{...snapshots[0].configs[0],paths:[{dHat:10,sigmaD:0}]}]};
  const failed=await request({type:'displayBatch',snapshots:[{t:12,configs:[]},bad],t:13,readFrom:13});
  assert.equal(failed.type,'error');
  assert.equal((await request({type:'step',snapshot:{t:13,configs:[]}})).type,'error');
  await request({type:'initDisplay',grid:baseGrid,numerical:{}});
  assert.equal((await request({type:'displayBatch',snapshots:[snapshots[0]],t:1,readFrom:1})).type,'error');
  assert.equal((await request({type:'step',snapshot:snapshots[0]})).type,'frame');
});
