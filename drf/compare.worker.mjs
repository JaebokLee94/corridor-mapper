import { MethodComparison } from './comparison.mjs?v=20261112-upper-wmp';
// Only declared range noise and measured snapshots cross the inference boundary.
let estimator;
globalThis.onmessage=({data})=>{
  try {
    const allowed=data.type==='init' ? ['type','requestId','sigmaR','vehicles','domain'] : ['type','requestId','snapshot'];
    if (Object.keys(data).some(k=>!allowed.includes(k))) throw new Error('Non-measurement worker input');
    if (data.type==='init') {
      estimator=new MethodComparison({includeExtended:true, vehicles:data.vehicles, domain:data.domain, sigmaR:data.sigmaR});
      globalThis.postMessage({type:'initialized',requestId:data.requestId});
    } else if (data.type==='step') {
      if (!estimator) throw new Error('Comparison worker must be initialized');
      const methods=estimator.step(data.snapshot);
      globalThis.postMessage({type:'candidates',requestId:data.requestId,t:data.snapshot.t,methods});
    } else throw new Error('Unknown comparison message');
  } catch(error) {globalThis.postMessage({type:'error',requestId:data.requestId,message:error.message});}
};
