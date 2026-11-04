import { createPSPTEvaluator } from './pspt-evaluate.mjs?v=20261022-audit1';
import { diffuseProfile } from './diffuse.mjs';
let evaluator, baselineEvaluator, scenario;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') { scenario = data.scenario; evaluator = createPSPTEvaluator(scenario, data.grid); baselineEvaluator = createPSPTEvaluator(scenario, data.grid); self.postMessage({ type: 'initialized', requestId: data.requestId }); }
    if (data.type === 'evaluate') {
      const guarded=evaluator.step(data.frame);
      const baseline=data.frame.methods ? baselineEvaluator.step({...data.frame,method:'baseline-b',candidates:data.frame.methods.baseline.candidates},guarded) : null;
      self.postMessage({type:'evaluation',requestId:data.requestId,evaluation:baseline ? {...guarded,methods:{guarded,baseline}} : guarded});
    }
    if (data.type === 'profile') {
      const snapshot = scenario.truth[data.t - 1], config = snapshot.configs[data.configIndex];
      const profile = diffuseProfile(scenario.spans, snapshot.p[config.i - 1], snapshot.p[config.j - 1], scenario.input.roughness * Math.PI / 180, scenario.input.lambda0, scenario.input.cellStep);
      self.postMessage({ type: 'profile', requestId: data.requestId, profile });
    }
  } catch (error) { self.postMessage({ type: 'error', requestId: data.requestId, message: error.message }); }
};
