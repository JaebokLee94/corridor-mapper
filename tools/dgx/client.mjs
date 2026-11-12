import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { normalizeInput } from '../../drf/scenario.mjs';
import { createTruthCache, createNodeStore } from '../../drf/truth-cache.mjs';
import { createScenarioPreparer, prepareScenario, warmTruthCache } from '../../drf/prepare-scenario.mjs';

function configuredEndpoint() {
  if(process.env.ECHOMAP_DGX_URL!==undefined) return process.env.ECHOMAP_DGX_URL;
  try { return JSON.parse(readFileSync(join(homedir(),'.config','echomap','dgx.json'),'utf8')).url; }
  catch(err){ if(err.code==='ENOENT') return ''; throw err; }
}
export async function remoteScenario(raw, endpoint, progress=()=>{}, physicalOnly=false) {
  const input=normalizeInput(raw), url=new URL('/v1/measure',endpoint);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Use a loopback SSH tunnel');
  const started=performance.now(), truth=Array(input.snapshots), wire=Array(input.snapshots);
  const abort=new AbortController(), signal=AbortSignal.any([abort.signal,AbortSignal.timeout(120000)]);
  let cursor=1,done=0,geometry,bytes=0;
  async function receive(){
    while(cursor<=input.snapshots) {
      const start=cursor, end=Math.min(start+11,input.snapshots);cursor=end+1;
      const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input,start,end,physicalOnly}),signal,redirect:'error'});
      if(!res.ok || res.headers.get('x-echomap-protocol')!=='1') throw new Error('DGX response '+res.status);
      const buffer=Buffer.from(await res.arrayBuffer()); bytes+=buffer.length;
      const chunk=deserialize(gunzipSync(buffer,{maxOutputLength:512*1024*1024}));
      if(chunk.start!==start||chunk.end!==end||chunk.frames.length!==end-start+1) throw new Error('DGX returned an incomplete interval');
      if(start===1) geometry=chunk.geometry;
      for(const [i,frame] of chunk.frames.entries()) {
        const t=start+i;
        const physical=physicalOnly ? frame : frame.truth;
        if(physical.t!==t || (!physicalOnly && (frame.wire.t!==t||frame.wire.configs.length!==input.vehicles*(input.vehicles-1)/2))) throw new Error('DGX snapshot mismatch');
        truth[t-1]=physical; if(!physicalOnly) wire[t-1]=frame.wire;
      }
      done+=chunk.frames.length;progress(done,input.snapshots);
    }
  }
  try {await Promise.all(Array.from({length:Math.min(6,Math.ceil(input.snapshots/12))},receive));}
  finally {abort.abort();}
  if(!geometry?.spans||done!==input.snapshots) throw new Error('Missing DGX scene');
  if(physicalOnly) return {vehicles:input.vehicles,snapshots:input.snapshots,geometry,truth};
  return {input,...geometry,truth,wire,simulatorMs:performance.now()-started,measurementBackend:'dgx-cuda',measurementBytes:bytes};
}
// Keep Linux/CUDA-produced paths separate from the original CPU bank. Preserve its
// noise-independent key, capacity checks and eviction limits for seeds 1–10.
let dgxCache;
async function cachedRemoteScenario(input, endpoint, progress, options) {
  dgxCache ??= createNodeStore({directory:join(process.env.ECHOMAP_TRUTH_CACHE_DIR ||
    join(homedir(),'Library','Caches','EchoMapCompute'),'dgx-physical-v1')})
    .then(persistent=>createTruthCache({persistent,packaged:null}));
  const store=await dgxCache;
  let source;
  const prepare=createScenarioPreparer({cache:{getTruthBundle:async input=>{
    const result=await store.getTruthBundle(input,()=>remoteScenario(input,endpoint,progress,true));
    source=result.source;
    return result;
  }}});
  const scenario=await prepare(input,progress,options);
  return {...scenario,measurementBackend:source==='generated'?'dgx-cuda-physical':'dgx-physical-cache'};
}
// Called by both local job types and the Node batch runner. A strict batch must not silently benchmark CPU fallback.
export async function prepareNodeScenario(raw, progress=()=>{}, options={}) {
  const endpoint=configuredEndpoint();
  const input=normalizeInput(raw);
  if(!endpoint || !input.roughness || !input.lambda0) return prepareScenario(input,progress,options);
  if(await warmTruthCache(input)) {
    const scenario=await prepareScenario(input,progress,options);
    return {...scenario,measurementBackend:'local-physical-cache'};
  }
  let completed=0;
  const report=(t,total)=>{completed=Math.max(completed,t);progress(completed,total);};
  options.onPhase?.('dgx');
  try {
    if(input.seed>=1 && input.seed<=10 && input.vehicles<=10) return await cachedRemoteScenario(input,endpoint,report,options);
    return await remoteScenario(input,endpoint,report);
  }
  catch(err) {
    if(process.env.ECHOMAP_DGX_STRICT==='1') throw err;
    console.warn('DGX measurement unavailable; generating on CPU:',err.message);
    options.onPhase?.('local-fallback');
    const scenario=await prepareScenario(input,report);
    return {...scenario,measurementBackend:'cpu-fallback'};
  }
}
