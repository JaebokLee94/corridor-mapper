import {normalizeInput,measureTruthSnapshot} from './scenario.mjs';
import {prepareScenario,warmTruthCache} from './prepare-scenario.mjs?v=20261104-background2';

const publicOrigin='https://jaeboklee94.github.io', endpoint='https://echomap-measure.umkuku-auth.workers.dev/v1/physical';
// Keep cached physical paths and online inference separate. Public clients apply the same seeded noise locally.
export async function fetchPublicScene(input,progress,fetchBlock=fetch){
 const before=performance.now(),truth=[],wire=[];let geometry;
 for(let start=1;start<=input.snapshots;start+=12){
   const end=Math.min(start+11,input.snapshots);
   const res=await fetchBlock(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input,start,end}),signal:AbortSignal.timeout(23000),credentials:'omit',redirect:'error'});
   if(!res.ok)throw Error('H200 HTTP '+res.status);
   const raw=await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).json();
   if(raw.start!==start||raw.end!==end||raw.frames?.length!==end-start+1)throw Error('Incomplete H200 measurement block');
   if(start===1){geometry=raw.geometry;if(!geometry?.spans||!geometry?.domain)throw Error('H200 geometry missing');}
   for(const [k,frame] of raw.frames.entries()){
     if(frame.t!==start+k)throw Error('H200 snapshot out of order');
     const measured=measureTruthSnapshot(input,frame);truth.push(measured.truth);wire.push(measured.wire);
   }
   progress(end,input.snapshots);
 }
 return {input,...geometry,truth,wire,simulatorMs:performance.now()-before,measurementBackend:'public-dgx-cuda'};
}
export async function preparePublicScenario(raw,progress=()=>{},options={}){
 const input=normalizeInput(raw);
 if(globalThis.location?.origin!==publicOrigin)return prepareScenario(input,progress,options);
 if(await warmTruthCache(input)){
   const scene=await prepareScenario(input,progress,options);return {...scene,measurementBackend:'saved-physical-paths'};
 }
 if(input.vehicles<=10&&input.cellStep>=.02&&input.lambda0>0&&input.lambda0<=15&&input.roughness>0&&input.roughness<=10){
   options.onPhase?.('dgx');let last=0;
   try{return await fetchPublicScene(input,(t,n)=>{last=t;progress(t,n);});}
   catch(err){if(err.message==='Cancelled')throw err;
     options.onPhase?.('local-fallback');
     const scene=await prepareScenario(input,(t,n)=>progress(Math.max(last,t),n));
     return {...scene,measurementBackend:'browser-fallback'};
   }
 }
 options.onPhase?.('browser');
 return {...await prepareScenario(input,progress),measurementBackend:'browser'};
}
