import { EchoComparison } from './echo-comparison.mjs?v=20261117-arc-webgpu';
// Only declared range noise and measured snapshots cross the inference boundary.
let estimator,side;
globalThis.onmessage=async ({data})=>{
  try {
    const allowed=data.type==='init' ? ['type','requestId','sigmaR','vehicles','domain','scene','echoKnotM','echoSupportM','rightMethod','side'] : ['type','requestId','snapshot'];
    if (Object.keys(data).some(k=>!allowed.includes(k))) throw new Error('Non-measurement worker input');
    if (data.type==='init') {
      side=data.side;
      if(side && !['echoSpline','guarded'].includes(side))throw new Error('Unknown estimator side');
      estimator?.close();
      estimator=new EchoComparison({...data,sigmaD:data.sigmaR},data.domain,side);
      if(side!=='echoSpline' && data.rightMethod)await estimator.loadModel({useGpu:true});
      globalThis.postMessage({type:'initialized',requestId:data.requestId});
    } else if (data.type==='step') {
      if (!estimator) throw new Error('Comparison worker must be initialized');
      const methods=await (side?estimator.stepSide(side,data.snapshot):estimator.step(data.snapshot));
      globalThis.postMessage({type:'candidates',requestId:data.requestId,t:data.snapshot.t,methods});
    } else throw new Error('Unknown comparison message');
  } catch(error) {globalThis.postMessage({type:'error',requestId:data.requestId,message:error.message});}
};
