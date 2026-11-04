import { prepareScenario as generateScenario } from './prepare-scenario.mjs?v=20261104-background2';
self.onmessage = async ({ data }) => {
  if (data.type !== 'generate') return;
  try {
    const scenario = await generateScenario(data.input, (t, total) => self.postMessage({ type: 'progress', t, total }));
    self.postMessage({ type: 'scenario', requestId: data.requestId, scenario });
  } catch (error) { self.postMessage({ type: 'error', requestId: data.requestId, message: error.message }); }
};
