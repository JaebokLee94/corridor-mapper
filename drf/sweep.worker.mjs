import { runExperiment } from './sweep.mjs?v=20261104-truthcache1';
self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  try {
    const result = await runExperiment(data.input);
    self.postMessage({ type: 'result', id: data.id, result }, [result.final.Dbar.buffer, result.final.betaHat.buffer]);
  } catch (error) { self.postMessage({ type: 'error', id: data.id, message: error.message }); }
};
