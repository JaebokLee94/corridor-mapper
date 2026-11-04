import { MethodComparison } from './comparison.mjs?v=20261022-audit1';
// Only declared range noise and measured snapshots cross the inference boundary.
let estimator;
globalThis.onmessage=({data})=>{
  try {
    const allowed=data.type==='init' ? ['type','requestId','sigmaR'] : ['type','requestId','snapshot'];
    if (Object.keys(data).some(k=>!allowed.includes(k))) throw new Error('Non-measurement worker input');
    if (data.type==='init') {
      estimator=new MethodComparison({sigmaR:data.sigmaR});
      globalThis.postMessage({type:'initialized',requestId:data.requestId});
    } else if (data.type==='step') {
      if (!estimator) throw new Error('Comparison worker must be initialized');
      const methods=estimator.step(data.snapshot);
      globalThis.postMessage({type:'candidates',requestId:data.requestId,t:data.snapshot.t,methods});
    } else throw new Error('Unknown comparison message');
  } catch(error) {globalThis.postMessage({type:'error',requestId:data.requestId,message:error.message});}
};
