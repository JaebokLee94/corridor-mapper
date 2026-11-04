import { normalizeInput, createSceneGeometry, generateTruthSnapshot, measureTruthSnapshot, generateSnapshot } from './scenario.mjs?v=20261104-truthcache1';
import { getTruthBundle } from './truth-cache.mjs';

const eligible = input => input.seed >= 1 && input.seed <= 10 && input.vehicles <= 10;
/** Read existing raw paths only. A miss must never generate paths, add noise or
 * run an estimator before Run. The same worker retains the validated cache hit.
 */
export function createTruthWarmer({ cache = { getTruthBundle } } = {}) {
  return async raw => {
    const input = normalizeInput(raw);
    if (!eligible(input)) return false;
    try {
      await cache.getTruthBundle(input, () => { throw new Error('No existing truth to preload'); });
      return true;
    } catch { return false; }
  };
}
export const warmTruthCache = createTruthWarmer();

function yieldGeneration() {
  if (typeof MessageChannel === 'undefined') return new Promise(resolve => setTimeout(resolve, 0));
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
}

/** The uncached composition matches generateScenario, with worker-task scheduling
 * instead of a timer after each snapshot. Keep this small orchestration wrapper
 * here: scenario.mjs and its numerical dependencies fingerprint the raw bank.
 * Input: normalized settings. Output: unchanged geometry/truth/wire contract.
 * Work and memory are unchanged; generateSnapshot owns all numerical operations.
 */
async function prepareUncached(input, progress, yieldTask) {
  const started = performance.now(), geometry = createSceneGeometry(input), truth = [], wire = [];
  for (let t = 1; t <= input.snapshots; t++) {
    const result = generateSnapshot(input, geometry.spans, t, geometry.wallModel);
    truth.push(result.truth); wire.push(result.wire); progress(t, input.snapshots);
    await yieldTask();
  }
  return { input, ...geometry, truth, wire, simulatorMs: performance.now() - started };
}

/** Build physical paths only. Cost is the original scattering/root calculation
 * for every requested pair and time; memory is proportional to the raw paths.
 * It stores no measured positions, range noise, decisions or fitted thresholds.
 */
export async function buildTruthBundle(raw, progress = () => {}) {
  const input = normalizeInput(raw), geometry = createSceneGeometry(input), truth = [];
  for (let t = 1; t <= input.snapshots; t++) {
    truth.push(generateTruthSnapshot(input, geometry.spans, t, geometry.wallModel));
    progress(t, input.snapshots);
    if (t % 4 === 0) await yieldGeneration();
  }
  return { vehicles: input.vehicles, snapshots: input.snapshots, geometry, truth };
}

/** Prepare the same scenario as uncached generateScenario. Cache only physical
 * paths; current sigmaP/sigmaD and observation settings are applied afresh. V/T
 * select a vehicle-ID/time prefix, never a prefix of the pair array. Online
 * consumers still receive only wire[t]; truth remains simulator/evaluator data.
 * onCache is an optional diagnostic callback, not part of the scenario schema.
 */
export function createScenarioPreparer({ cache = { getTruthBundle }, yieldTask = yieldGeneration } = {}) {
  return async function prepare(raw, progress = () => {}, { onCache = () => {}, onPhase = () => {} } = {}) {
    const started = performance.now(), input = normalizeInput(raw);
    if (!eligible(input)) {
      onPhase('generating');
      onCache({ source: 'uncached', vehicles: input.vehicles, snapshots: input.snapshots });
      return prepareUncached(input, progress, yieldTask);
    }
    let latest = 0;
    const report = t => { latest = Math.max(latest, t); progress(latest, input.snapshots); };
    onPhase('loading');
    const { bundle, source } = await cache.getTruthBundle(input, () => {
      onPhase('generating');
      return buildTruthBundle(input, report);
    });
    onCache({ source, vehicles: bundle.vehicles, snapshots: bundle.snapshots });
    onPhase('measuring');
    const truth = [], wire = [];
    for (let t = 1; t <= input.snapshots; t++) {
      // Also checks cancellation after an asynchronous disk/network cache read.
      report(t);
      const measured = measureTruthSnapshot(input, bundle.truth[t - 1]);
      truth.push(measured.truth); wire.push(measured.wire);
      if (t % 8 === 0) await yieldTask();
    }
    return { input, ...structuredClone(bundle.geometry), truth, wire, simulatorMs: performance.now() - started };
  };
}

export const prepareScenario = createScenarioPreparer();
