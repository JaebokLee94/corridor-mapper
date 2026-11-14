import { preparePublicScenario } from './public-measure.mjs?v=20261112-upper-wmp';
import { runExperiment } from './sweep.mjs?v=20261114-wmp';
self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  try {
    const result = await runExperiment(data.input,undefined,preparePublicScenario);
    self.postMessage({ type: 'result', id: data.id, result }, [result.final.Dbar.buffer, result.final.betaHat.buffer]);
  } catch (error) { self.postMessage({ type: 'error', id: data.id, message: error.message }); }
};
