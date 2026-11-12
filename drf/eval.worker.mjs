import { createPSPTEvaluator } from './pspt-evaluate.mjs?v=20261112-checkedcentre';
import { diffuseProfile } from './diffuse.mjs';
import { createSweepProfileSource } from './diagnostic-profile.mjs';
let evaluator, baselineEvaluator, scenario;
let sweepSource, sweepKey;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'sweep-source' || data.type === 'sweep-profile') {
      const key = JSON.stringify(data.input);
      if (key !== sweepKey) { sweepSource = createSweepProfileSource(data.input); sweepKey = key; }
      const { domain, t, configs } = sweepSource;
      self.postMessage({ type: 'sweep-diagnostic', requestId: data.requestId, domain, t, configs,
        ...(data.type === 'sweep-profile' ? { profile: sweepSource.profile(data.configIndex) } : {}) });
    }
    if (data.type === 'init') { scenario = data.scenario; evaluator = createPSPTEvaluator(scenario, data.grid); baselineEvaluator = createPSPTEvaluator(scenario, data.grid); self.postMessage({ type: 'initialized', requestId: data.requestId }); }
    if (data.type === 'evaluate') {
      const guarded=evaluator.step(data.frame, null, data.frame.methods?.guarded?.bridges, data.frame.methods?.guarded?.extendedBridges);
      const baseline=data.frame.methods ? baselineEvaluator.step({...data.frame,method:'baseline-b',candidates:data.frame.methods.baseline.candidates},guarded,data.frame.methods.baseline.bridges, data.frame.methods.baseline.extendedBridges) : null;
      self.postMessage({type:'evaluation',requestId:data.requestId,evaluation:baseline ? {...guarded,methods:{guarded,baseline}} : guarded});
    }
    if (data.type === 'profile') {
      const snapshot = scenario.truth[data.t - 1], config = snapshot.configs[data.configIndex];
      const profile = diffuseProfile(scenario.spans, snapshot.p[config.i - 1], snapshot.p[config.j - 1], scenario.input.roughness * Math.PI / 180, scenario.input.lambda0, scenario.input.cellStep);
      self.postMessage({ type: 'profile', requestId: data.requestId, profile });
    }
  } catch (error) { self.postMessage({ type: 'error', requestId: data.requestId, message: error.message }); }
};
