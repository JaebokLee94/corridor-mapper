// ECHOMAP_DGX_URL=http://127.0.0.1:18901 node tools/dgx/benchmark.mjs > results.jsonl
// Each trial includes transfer, decompression and construction of the complete scenario on the requesting host.
import assert from 'node:assert/strict';
import { remoteScenario } from './client.mjs';
import { createScenarioPreparer } from '../../drf/prepare-scenario.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const cpu=createScenarioPreparer({cache:{getTruthBundle:async (_input,build)=>({source:'forced fresh',bundle:await build()})}});
const endpoint=process.env.ECHOMAP_DGX_URL;
if(!endpoint) throw new Error('Set ECHOMAP_DGX_URL');
function compare(a,b,stats,path='') {
  if(typeof a==='number'){
    if(a===b||Object.is(a,b))return;
    const delta=Math.abs(a-b);stats.different++;stats.max=Math.max(stats.max,delta);
    assert.ok(delta<=1e-10+1e-10*Math.max(Math.abs(a),Math.abs(b)),path+' differs by '+delta);
  } else if(a && typeof a==='object'){
    if(Array.isArray(a)){assert.ok(Array.isArray(b));assert.equal(a.length,b.length,path);for(let i=0;i<a.length;i++)compare(a[i],b[i],stats,path+'['+i+']');}
    else{assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),path);for(const k of Object.keys(a))compare(a[k],b[k],stats,path+'.'+k);}
  } else assert.equal(a,b,path);
}
const control=process.env.ECHOMAP_DGX_CONTROL_URL;
const cold=performance.now();await remoteScenario({seed:583,vehicles:3,snapshots:1},endpoint);
console.log(JSON.stringify({firstSmallRequestMs:performance.now()-cold}));
if(control) for(const v of [3,10]) for(const url of [control,endpoint]) await remoteScenario({seed:9043,vehicles:v,snapshots:120},url);
for(const [seed,vehicles,rep] of [[6,3,1],[6,10,1],[6,10,2],[6,3,2],[6,3,3],[6,10,3],[157913,3,1],[157913,10,1]]) {
  const input={seed,vehicles,snapshots:120}, times={};let local,remote;
  for(const key of rep%2?['cpu','gpu']:['gpu','cpu']) {
    const t=performance.now();
    if(key==='cpu') local=await cpu(input); else remote=await remoteScenario(input,endpoint);
    times[key]=performance.now()-t;
  }
  if(control) {
    const t=performance.now(), remoteCpu=await remoteScenario(input,control);
    times.dgxCpu=performance.now()-t;
    compare(local.wire,remoteCpu.wire,{different:0,max:0},'Linux CPU');
  }
  const wire={different:0,max:0},truth={different:0,max:0};
  compare(local.wire,remote.wire,wire,'wire');compare(local.truth,remote.truth,truth,'truth');
  const wireExact=isDeepStrictEqual(local.wire,remote.wire);
  console.log(JSON.stringify({seed,vehicles,rep,times,bytes:remote.measurementBytes,wire,truth,wireExact,wireSHA:createHash('sha256').update(JSON.stringify(local.wire)).digest('hex')}));
}
