import { experimentSettings as normalizeInput } from './experiment-settings.mjs';
import { prepareScenario as generateScenario } from './prepare-scenario.mjs?v=20261112-upper-wmp';
import { createGrid, createField } from './field.mjs';
import { percentile } from './statistics.mjs';
import { createPSPTEvaluator } from './pspt-evaluate.mjs?v=20261112-chain-tips';
import { EchoComparison } from './echo-comparison.mjs?v=20261114-wmp';

function summarize(frame, evaluation) {
  const keys = ['precision', 'surfacePrecision', 'recall', 'holdRate', 'firstSupportPrecision',
    'medianError', 'p95', 'offwall', 'f1', 'observedFraction', 'missing',
    'supportedCount', 'pendingCount', 'rejectedCount'];
  if(evaluation.method==='echoSpline') return {...Object.fromEntries(keys.map(k=>[k,evaluation[k]])),rawMapF1:evaluation.interpolation.rawMap.mapF1,mapRecall:evaluation.recall,Q:frame.Q,admitted:frame.admitted,rejected:frame.rejected};
  return { ...Object.fromEntries(keys.map(key => [key, evaluation[key]])),
    checkedCentreMapF1:evaluation.interpolation.checked.mapF1,
    rawMapF1:evaluation.interpolation.rawMap.mapF1, linearMapF1:evaluation.interpolation.mapF1,
    hermiteMapF1:evaluation.interpolation.hermite.mapF1, centreMapF1:evaluation.interpolation.centre.mapF1,
    mapRecall: evaluation.interpolation.recall, interpolatedLengthM: evaluation.interpolation.lengthM,
    interpolatedOffWallM: evaluation.interpolation.offWallM, hermiteMapRecall: evaluation.interpolation.hermite.recall,
    hermiteLengthM: evaluation.interpolation.hermite.lengthM, hermiteOffWallM: evaluation.interpolation.hermite.offWallM,
    centreMapRecall:evaluation.interpolation.centre.recall, centreMapLengthM:evaluation.interpolation.centre.lengthM, centreMapOffWallM:evaluation.interpolation.centre.offWallM,
    Q: frame.Q, admitted: frame.admitted, rejected: frame.rejected };
}
/** Paired sweep uses the same causal estimators and thresholds as the main view.
 * Each seed generates one shared measurement sequence. No per-condition tuning.
 * Memory O(field + truth + estimator state); frame history is not retained.
 */
export async function runExperiment(raw, progress = () => {}, prepare = generateScenario) {
  const input = normalizeInput(raw);
  if (input.sigmaD === 0) throw new Error('Both methods require range SD σd > 0; exact zero range noise is unsupported.');
  const scenario = await prepare(input), grid = createGrid(input.grid, input.grid, scenario.domain),
    field = createField(grid, { band: input.band, perimeter: input.perimeter }),
    evaluators = Object.fromEntries(['echoSpline', 'guarded'].map(key => [key, createPSPTEvaluator(scenario, grid)])),
    estimator = new EchoComparison(input,scenario.domain), timings = [];
  let frame, evaluations, fieldMs = 0, evaluationMs = 0;
  const estimatorMs = { echoSpline: 0, guarded: 0 };
  for (const wire of scenario.wire) {
    frame = field.step(wire); fieldMs += frame.ms;
    const methods = estimator.step(wire);
    for (const key of Object.keys(methods)) estimatorMs[key] += methods[key].ms;
    timings.push(frame.ms + methods.guarded.ms + methods.echoSpline.ms);
    const start = performance.now();
    const guarded = evaluators.guarded.step({ ...frame, method: 'guarded-tuned', candidates: methods.guarded.candidates }, null, methods.guarded.bridges, methods.guarded.extendedBridges, methods.guarded.checkedChains);
    const echoSpline = evaluators.echoSpline.step({...frame,...methods.echoSpline},guarded);
    evaluations = { echoSpline, guarded }; evaluationMs += performance.now() - start;
    progress(frame.t, input.snapshots);
  }
  return { input, wallGeneration: scenario.wallGeneration, method: 'paired-comparison', protocol: estimator.protocol,
    methods: Object.fromEntries(Object.entries(evaluations).map(([key, evaluation]) => [key, { summary: summarize(frame, evaluation) }])),
    diagnostics: evaluations.guarded.diagnostics,
    timing: { ...(scenario.measurementBackend ? { measurementBackend:scenario.measurementBackend } : {}), simulatorMs: scenario.simulatorMs, fieldMs, estimatorMs, evaluationMs,
      frameP50: percentile(timings, .5), frameP95: percentile(timings, .95) },
    final: { t: frame.t, Dbar: frame.Dbar, betaHat: frame.betaHat, Q: frame.Q, admitted: frame.admitted, rejected: frame.rejected },
  };
}
export function parseValues(text, integer = false) {
  const values = String(text).split(/[\s,]+/).filter(Boolean).map(Number);
  if (!values.length || values.some(v => !Number.isFinite(v) || (integer && (!Number.isInteger(v) || v < 0 || v > 0xffffffff)))) throw new Error('Enter valid comma-separated numbers.');
  if (new Set(values).size !== values.length) throw new Error('Remove duplicate values or seeds.');
  return values;
}
export function sweepJobs(base, noise, roughness, seeds) {
  if (noise.length * roughness.length * seeds.length > 1000) throw new Error('A sweep supports at most 1,000 seed/condition combinations.');
  return roughness.flatMap(r => noise.flatMap(d => seeds.map(seed => normalizeInput({ ...base, sigmaD: d, roughness: r, seed }))));
}
export function aggregateRuns(runs) {
  const groups = new Map();
  for (const run of runs) for (const [method, result] of Object.entries(run.methods ?? { historical: { summary: run.summary } })) {
    // A changed duration, fleet, geometry or protocol must never silently pool.
    const { seed, ...condition } = run.input;
    const protocol = run.protocol?.[method] ?? null;
    const key = JSON.stringify([method, condition, protocol]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...run, method, methodProtocol: protocol, summary: result.summary });
  }
  const fields = ['precision', 'recall', 'holdRate', 'firstSupportPrecision', 'medianError', 'p95', 'offwall', 'f1', 'observedFraction'];
  return [...groups.values()].map(group => {
    const { seed, ...input } = group[0].input;
    const row = { method: group[0].method, protocol: group[0].methodProtocol, input, seeds: group.map(run => run.input.seed), roughness: input.roughness, sigmaD: input.sigmaD, n: group.length };
    for (const key of fields) {
      const all = group.map(run => run.summary[key]), values = all.filter(Number.isFinite), n = values.length,
        missing = all.filter(v => v == null).length, failed = all.length - n - missing,
        positive = all.includes(Infinity), negative = all.includes(-Infinity),
        invalid = all.some(v => v != null && !Number.isFinite(v) && v !== Infinity && v !== -Infinity);
      // Observed failures must not disappear into a finite-only performance average.
      const mean = failed ? invalid || (positive && negative) ? NaN : positive ? Infinity : -Infinity
        : n ? values.reduce((s, v) => s + v, 0) / n : null;
      row[key] = { mean, sd: !failed && n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : null,
        n, failed, missing };
    }
    return row;
  }).sort((a, b) => a.roughness - b.roughness || a.sigmaD - b.sigmaD || ['echoSpline','guarded','baseline','historical'].indexOf(a.method) - ['echoSpline','guarded','baseline','historical'].indexOf(b.method));
}
/** Bounded pool: at most four default jobs, no frame history.
 * Cancellation terminates workers and keeps only fully completed seed results. */
export function startSweep(jobs, onProgress, workerCount = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))) {
  const results = [], workers = []; let next = 0, completed = 0, cancelled = false, settled = false;
  let finish, fail;
  const promise = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const stop = () => workers.forEach(worker => worker.terminate());
  function dispatch(worker) {
    if (next >= jobs.length) return;
    const id = next++; worker.postMessage({ type: 'run', input: jobs[id], id });
  }
  const count = Math.min(jobs.length, workerCount);
  for (let k = 0; k < count; k++) {
    const worker = new Worker(new URL('./sweep.worker.mjs?v=20261114-wmp', import.meta.url), { type: 'module' }); workers.push(worker);
    worker.onmessage = ({ data }) => {
      if (cancelled || settled) return;
      if (data.type === 'error') { settled = true; stop(); fail(new Error(data.message)); return; }
      if (data.type === 'result') {
        const { final, ...record } = data.result; results.push(record); completed++; onProgress({ completed, total: jobs.length, results });
        if (completed === jobs.length) { settled = true; stop(); finish({ results, cancelled: false }); }
        else dispatch(worker);
      }
    };
    worker.onerror = event => { if (!settled) { settled = true; stop(); fail(new Error(event.message)); } };
    dispatch(worker);
  }
  if (!count) { settled = true; finish({ results, cancelled: false }); }
  return { promise, cancel() { if (settled) return; cancelled = true; settled = true; stop(); finish({ results, cancelled: true }); } };
}
