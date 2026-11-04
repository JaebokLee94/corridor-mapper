import { PSPT } from './pspt.mjs';

// This worker receives measured snapshots only. No scenario, wall-side setting,
// ground truth, evaluation result, or future sequence crosses this boundary.
let estimator;
globalThis.onmessage = ({ data }) => {
  try {
    const allowed = data.type === 'init' ? ['type', 'requestId'] : ['type', 'requestId', 'snapshot'];
    if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('Non-measurement worker input');
    if (data.type === 'init') {
      estimator = new PSPT();
      globalThis.postMessage({ type: 'initialized', requestId: data.requestId, method: 'guarded45', grid: [100, 100] });
    } else if (data.type === 'step') {
      if (!estimator) throw new Error('PSPT worker must be initialized');
      const start = performance.now(), candidates = estimator.step(data.snapshot);
      globalThis.postMessage({ type: 'candidates', requestId: data.requestId, t: data.snapshot.t,
        candidates, psptMs: performance.now() - start, method: 'guarded45' });
    } else throw new Error('Unknown PSPT worker message');
  } catch (error) {
    globalThis.postMessage({ type: 'error', requestId: data.requestId, message: error.message });
  }
};
