import { parentPort } from 'node:worker_threads';
import { runExperiment } from '../drf/sweep.mjs';

// Each worker owns one complete seed/condition run. No estimator state is shared
// between jobs and both estimators still consume the same causal measurement wire.
parentPort.on('message', async ({ id, input }) => {
  try {
    parentPort.postMessage({ type: 'progress', id, phase: 'generating', snapshot: 0, total: input.snapshots });
    const { final, ...run } = await runExperiment(input, (snapshot, total) => {
      parentPort.postMessage({ type: 'progress', id, phase: 'evaluating', snapshot, total });
    }, (snapshot, total) => {
      parentPort.postMessage({ type: 'progress', id, phase: 'generating', snapshot, total });
    });
    // Sweep charts require completed seed summaries, not large display fields.
    parentPort.postMessage({ type: 'result', id, run });
  } catch (error) {
    parentPort.postMessage({ type: 'error', id, message: error.message });
  }
});
