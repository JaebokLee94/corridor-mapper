import { experimentSettings } from './experiment-settings.mjs?v=20261119-cnn-stride4';
import { preparePublicScenario } from './public-measure.mjs?v=20261114-wall-geometry';
import { workerMethod } from './method-client.mjs?v=20261127-independent-field';
import { createGrid } from './field.mjs?v=20261119-cnn-stride4';
import { createPSPTEvaluator } from './pspt-evaluate.mjs?v=20261117-map-metrics';
import { activeRightMethods } from './right-methods.mjs?v=20261119-cnn-stride4';
import { percentile } from './statistics.mjs';

export const benchmarkMethods = ['echoSpline', ...activeRightMethods];
export function benchmarkCases(base, scope = 'current') {
  if (scope === 'current') return [{ id: 'current', input: experimentSettings(base) }];
  if (scope !== 'matrix') throw new Error('Unknown benchmark conditions');
  return ['simple', 'rugged'].flatMap(wall => [3, 10].map(vehicles => ({
    id: wall + '-' + vehicles,
    input: experimentSettings({ ...base, scene: 'paper-upper', wallSide: 'upper', vehicles,
      sigmaP: 0, sigmaD: .4, roughness: 0, lambda0: 0, resolution: .6, specular: true,
      ...(wall === 'simple' ? { sigmaM: 6, deltaM: 20, sigmaDGeometry: .33, deltaD: 4 }
        : { sigmaM: 11.7, deltaM: 9, sigmaDGeometry: 2.72, deltaD: 1 }) }),
  })));
}
export const deviceVariants = method => [
  { id: 'cpu', computeDevice: 'cpu' }, { id: 'gpu', computeDevice: 'gpu' },
  ...(method==='spline-cnn-fast' ? [{ id: 'neural-gpu', computeDevice: 'gpu', echoBackend: 'cpu' }] : []),
];
export function benchmarkPlan(methods, repeats, warmup) {
  if (!methods.length || methods.some(m => !benchmarkMethods.includes(m)) || new Set(methods).size !== methods.length)
    throw new Error('Choose distinct supported methods');
  if (![1, 3, 5].includes(repeats)) throw new Error('Use 1, 3 or 5 measured repetitions');
  const plan = [];
  for (let round = warmup ? -1 : 0; round < repeats; round++) {
    const offset = Math.max(0, round) % methods.length;
    for (const method of [...methods.slice(offset), ...methods.slice(0, offset)]) {
      const variants = deviceVariants(method), shift = Math.max(0, round) % variants.length;
      for (const variant of [...variants.slice(shift), ...variants.slice(0, shift)])
        plan.push({ method, variant, round, stage: round < 0 ? 'warmup' : 'measured' });
    }
  }
  return plan;
}
function canonical(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const encode = value => JSON.stringify(canonical(value));
async function sha(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encode(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
function wallOutput(result) {
  return Object.fromEntries(['curves', 'candidates', 'bridges', 'extendedBridges', 'checkedChains']
    .filter(k => result[k] !== undefined).map(k => [k, result[k]]));
}
// For p(s)=c+s*a+s²*b on [-1,1], ||Δp|| <= ||Δc||+||Δa||+||Δb||.
function patchDisplacementBound(a, b) {
  const coefficients = c => {
    const tx = Math.cos(c.phi), ty = Math.sin(c.phi), bend = .5 * c.kappa * c.sg * c.ell * c.ell;
    return [c.center, [c.ell * tx, c.ell * ty], [-bend * ty, bend * tx]];
  };
  if (![a,b].every(c => c?.center?.length === 2 && [...c.center,c.phi,c.kappa,c.sg,c.ell].every(Number.isFinite))) return null;
  const first = coefficients(a), second = coefficients(b);
  return first.reduce((sum, p, i) => sum + Math.hypot(p[0] - second[i][0], p[1] - second[i][1]), 0);
}
function discreteChanges(a, b) {
  if (Object.is(a,b) || typeof a === 'number' && typeof b === 'number') return 0;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].reduce((n,k) => n + (Object.hasOwn(a,k) && Object.hasOwn(b,k) ? discreteChanges(a[k],b[k]) : 1), 0);
  }
  return 1;
}
export function compareWallOutputs(actual, reference) {
  const a = actual.curves ?? [], b = reference.curves ?? [];
  let sameCurveShape = a.length === b.length, changedVertices = 0, maxVertexDistanceM = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]?.length !== b[i]?.length) sameCurveShape = false;
    for (let j = 0; j < Math.max(a[i]?.length ?? 0, b[i]?.length ?? 0); j++) {
      const p = a[i]?.[j], q = b[i]?.[j];
      if (!p || !q || p[0] !== q[0] || p[1] !== q[1]) changedVertices++;
      if (p && q) maxVertexDistanceM = Math.max(maxVertexDistanceM, Math.hypot(p[0] - q[0], p[1] - q[1]));
    }
  }
  const candidates = new Map((actual.candidates ?? []).map((c,i) => [c.id ?? i,c])),
    referenceCandidates = new Map((reference.candidates ?? []).map((c,i) => [c.id ?? i,c]));
  let maxCandidatePatchDisplacementBoundM = 0, unmatchedCandidates = 0;
  for (const id of new Set([...candidates.keys(), ...referenceCandidates.keys()])) {
    const p = candidates.get(id), q = referenceCandidates.get(id);
    if (!p || !q) { unmatchedCandidates++; continue; }
    const bound = patchDisplacementBound(p,q);
    if (bound != null) maxCandidatePatchDisplacementBoundM = Math.max(maxCandidatePatchDisplacementBoundM,bound);
  }
  return { exact: encode(actual) === encode(reference), sameCurveShape, changedVertices, maxVertexDistanceM,
    maxCandidatePatchDisplacementBoundM, unmatchedCandidates, discreteOutputChanges: discreteChanges(actual,reference) };
}
export function sampleBenchmarkFrames(frames, differences = []) {
  const indices = new Set([0, frames.length - 1, differences.findIndex(d => !d.exact)]);
  for (const key of ['maxVertexDistanceM', 'maxCandidatePatchDisplacementBoundM']) {
    const index = differences.reduce((best, d, i) => (d[key] ?? 0) > (differences[best]?.[key] ?? 0) ? i : best, -1);
    indices.add(index);
  }
  const frameIndices = [...indices].filter(i => i >= 0 && i < frames.length).sort((a,b) => a-b);
  return { frameIndices, frames: frameIndices.map(i => frames[i]) };
}
export function summarizeDeviceTrials(trials) {
  const groups = new Map();
  for (const trial of trials.filter(t => t.stage === 'measured' && t.status === 'complete')) {
    const key = trial.caseId + '/' + trial.method + '/' + trial.variant.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trial);
  }
  return [...groups.values()].map(group => {
    const first = group[0], times = group.map(t => t.totalMs), f1 = group.map(t => t.rows.at(-1)?.mapF1);
    const failure = trials.find(t => t.caseId === first.caseId && t.method === first.method && t.variant.id === first.variant.id
      && ['failed','unavailable'].includes(t.status) && (!t.retryableInitialization || t.retryExhausted));
    return { caseId: first.caseId, method: first.method, device: first.variant.id, n: group.length,
      medianMs: percentile(times, .5), minMs: Math.min(...times), maxMs: Math.max(...times),
      finalMapF1: f1[0], finalMapF1Min: Math.min(...f1), finalMapF1Max: Math.max(...f1),
      maxF1Difference: Math.max(...group.map(t => t.maxF1Difference ?? 0)),
      changedFrames: Math.max(...group.map(t => t.changedFrames ?? 0)),
      maxVertexDistanceM: Math.max(...group.map(t => t.maxVertexDistanceM ?? 0)),
      maxCandidatePatchDisplacementBoundM: Math.max(...group.map(t => t.maxCandidatePatchDisplacementBoundM ?? 0)),
      discreteOutputChanges: Math.max(...group.map(t => t.discreteOutputChanges ?? 0)),
      admissible: !failure && group.every(t => t.admissible), ...(failure ? {excludedReason:failure.error} : {}), backendVerified: group.every(t => t.backendVerified), outputExact: group.every(t => t.outputExact),
      updateP95Ms: percentile(group.flatMap(t => t.rows.map(r => r.ms)), .95) };
  });
}
/** Rejected or exhausted attempts stay visible without entering measured speed aggregates. */
export function benchmarkDisplayRows(record) {
  const rows = record.summary.map(row => ({...row, timingStage:'measured'})),
    displayed = new Set(rows.map(row => row.caseId + '/' + row.method + '/' + row.device));
  // Prefer the terminal visibility failure over any earlier retryable initialization error.
  for (const trial of record.trials) {
    if (trial.status !== 'hidden' || trial.attempt !== 3) continue;
    const key = trial.caseId + '/' + trial.method + '/' + trial.variant.id;
    if (displayed.has(key)) continue;
    displayed.add(key);
    rows.push({caseId:trial.caseId, method:trial.method, device:trial.variant.id, n:0,
      timingStage:trial.stage === 'warmup' ? 'warm-up' : 'screening', diagnosticMs:null, finalMapF1:null,
      excludedReason:'Page hidden on the final allowed attempt (3 attempts). Keep this tab visible and retry.'});
  }
  for (const trial of record.trials) {
    if (!trial.rejection && !['unavailable','failed'].includes(trial.status)) continue;
    const key = trial.caseId + '/' + trial.method + '/' + trial.variant.id;
    if (displayed.has(key)) continue;
    displayed.add(key);
    rows.push({caseId:trial.caseId, method:trial.method, device:trial.variant.id, n:0,
      timingStage:trial.stage === 'warmup' ? 'warm-up' : 'screening', diagnosticMs:trial.totalMs ?? null,
      finalMapF1:trial.rows?.at(-1)?.mapF1 ?? null, excludedReason:trial.rejection ?? trial.error,
      maxCandidatePatchDisplacementBoundM:trial.maxCandidatePatchDisplacementBoundM ?? 0,
      discreteOutputChanges:trial.discreteOutputChanges ?? 0});
  }
  return rows;
}
export function expectedGpuStages(method, variant) {
  if (variant === 'cpu') return [];
  if (method==='spline-cnn-fast') return variant === 'neural-gpu' ? ['neuralGpu'] : ['splineGpu', 'neuralGpu'];
  if (['arc', 'gat'].includes(method)) return ['neuralGpu'];
  return method === 'wmp' ? ['densityGpu'] : ['splineGpu'];
}
const abortError = () => new DOMException('Benchmark cancelled', 'AbortError');
function productionMethod(method, input, domain) {
  const worker = globalThis.__drfOffline?.worker('compare') ?? new Worker(new URL('./compare.worker.mjs?v=20261119-cnn-stride4', import.meta.url), { type: 'module' });
  return workerMethod(worker, method === 'echoSpline' ? 'echoSpline' : 'guarded', input, domain);
}

/** Same production worker and ordered N measurement prefixes as the live view, one worker at a time.
 * Estimator time excludes initialization, simulation, evaluation, hashing and UI. Truth reaches only
 * the evaluator. Memory O(N * emitted geometry) per retained CPU/device run; later repeats keep hashes.
 */
export function startDeviceBenchmark({ cases, methods, repeats = 3, warmup = true, onProgress = () => {},
  prepare = preparePublicScenario, makeMethod = productionMethod,
  makeEvaluator = (scene, input) => createPSPTEvaluator(scene, createGrid(input.grid, input.grid, scene.domain)),
  page = globalThis.document, localSave = false, source = null } = {}) {
  const plan = benchmarkPlan(methods, repeats, warmup), controller = new AbortController();
  const record = { schema: 'echomap-device-benchmark-v1', started: new Date().toISOString(), status: 'running',
    protocol: { snapshots: cases.map(c => c.input.snapshots), repeats, warmup, serial: true,
      timed: 'Sum of production estimator update milliseconds; initialization, generation, evaluation and rendering excluded',
      parity: 'Every prefix compared with the first completed CPU run; all prefix hashes and errors retained. Selected full frames use zero-based frameIndices: first, last, first difference and largest geometric differences.',
      hiddenPolicy: 'Abort hidden trials, retain their failure records and retry at most twice after the page becomes visible',
      initializationRetry: 'Retry Estimator worker failed only before initialization and before any estimator output; at most two additional attempts. CPU reference failure stops the benchmark.',
      acceptance: { maxVertexDistanceM: .002, maxMapF1Difference: .000001, sameCurveShape: true, nonCurveGeometry: 'exact', genuineGpuCalls: true },
      patchDifference: 'Diagnostic only: matched candidate ids; conservative displacement bound over normalized quadratic patch parameter [-1,1]. Discrete changes count nonnumeric leaves and added/removed fields; acceptance is unchanged.' },
    userAgent: globalThis.navigator?.userAgent ?? 'test', source, cases: [], trials: [], summary: [], total: cases.length * plan.length, completed: 0 };
  let active, visibilityWake;
  const cancelled = () => controller.signal.aborted;
  const check = () => { if (cancelled()) throw abortError(); };
  function emit(event = {}) { onProgress({ record, ...event }); }
  async function save(full = false) {
    if (!localSave) return;
    try {
      // Reposting cumulative geometry at every trial can retain gigabytes of request bodies in browser diagnostics.
      const payload = full ? record : { ...record, recordMode: 'progress',
        cases: record.cases.map(({ wires, evaluationTruth, ...rest }) => rest),
        trials: record.trials.map(({ frames, rows, ...rest }) => rest) };
      const response = await fetch('/__benchmark/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      record.saved = true;
    } catch (error) { record.saveError = error.message; }
  }
  async function waitVisible() {
    while (page?.hidden) {
      check(); emit({ message: 'Paused: keep this simulator tab visible.', phase: 'paused' });
      await new Promise(resolve => {
        const done = () => { page.removeEventListener('visibilitychange', done); controller.signal.removeEventListener('abort', done); visibilityWake = null; resolve(); };
        visibilityWake = done; page.addEventListener('visibilitychange', done); controller.signal.addEventListener('abort', done, { once: true });
      });
    }
    check();
  }
  async function trial(scene, condition, job, references, retained) {
    const { id: variantId, ...override } = job.variant;
    const { echoBackend, computeDevice, ...base } = condition.input;
    const input = { ...base, ...override, rightMethod: job.method === 'echoSpline' ? 'wmp' : job.method };
    const run = { caseId: condition.id, method: job.method, variant: job.variant, round: job.round,
      stage: job.stage, status: 'running', rows: [], visibilityEvents: [], started: new Date().toISOString() };
    record.trials.push(run);
    const expected = expectedGpuStages(job.method, variantId);
    const hasStages = info => !!info && !info.fallbackReason && expected.every(stage => info[stage] === true);
    const frames = [], evaluator = makeEvaluator(scene, input), start = performance.now();
    let hidden = false;
    const visibility = () => {
      run.visibilityEvents.push({ ms: performance.now() - start, state: page.visibilityState });
      if (page.hidden) { hidden = true; active?.close(); }
    };
    page?.addEventListener('visibilitychange', visibility);
    if (page) visibility();
    const timeout = setTimeout(() => { run.error = 'Trial exceeded 30 minutes'; active?.close(); }, 30 * 60 * 1000);
    try {
      check(); active = makeMethod(job.method, input, scene.domain);
      const initStart = performance.now(); run.initialized = await active.ready; run.initMs = performance.now() - initStart;
      if (variantId !== 'cpu' && !hasStages(run.initialized)) {
        run.unavailable = true;
        throw new Error('GPU stage unavailable: ' + expected.filter(stage => !run.initialized?.[stage]).join(', ') + (run.initialized?.fallbackReason ? '; ' + run.initialized.fallbackReason : ''));
      }
      for (const snapshot of scene.wire) {
        check(); if (hidden) throw new Error('Page became hidden');
        const requestStart = performance.now(), result = await active.step(snapshot), requestMs = performance.now() - requestStart;
        check(); if (hidden) throw new Error('Page became hidden');
        if (!Number.isFinite(result.ms) || result.ms < 0) throw new Error('Nonfinite estimator duration');
        const frame = wallOutput(result);
        if ((frame.curves ?? []).some(line => line.some(point => point.some(value => !Number.isFinite(value))))) throw new Error('Nonfinite wall coordinate');
        const evaluation = evaluator.step({ ...result, t: snapshot.t, curveMethod: job.method }, { diagnostics: {} }, result.bridges, result.extendedBridges, result.checkedChains);
        const mapF1 = evaluation.interpolation.rawMap.mapF1;
        const row = { t: snapshot.t, ms: result.ms, requestMs, mapF1, outputSha256: await sha(frame),
          backend: result.backend ?? 'CPU', gpuCalls: result.gpuCalls ?? 0, gpuCallsThisStep: result.gpuCallsThisStep ?? 0 };
        for (const key of ['gpuAdapter', 'device', 'gpuMode', 'gpuReadbacks', 'splineGpuCalls', 'neuralGpuCalls', 'densityGpuCalls', 'fallbackReason'])
          if (result[key] !== undefined) row[key] = result[key];
        frames.push(frame); run.rows.push(row);
        if (variantId !== 'cpu' && !hasStages(result.device)) { run.unavailable = true; throw new Error('GPU stage was lost during an update' + (result.device?.fallbackReason ? ': ' + result.device.fallbackReason : '')); }
        emit({ phase: 'running', caseId: condition.id, method: job.method, variant: variantId, stage: job.stage, round: job.round, snapshot: snapshot.t,
          message: condition.id + ' · ' + job.method + ' · ' + variantId + ' · ' + (job.stage === 'warmup' ? 'warmup' : 'repeat ' + (job.round + 1)) + ' · ' + snapshot.t + '/' + scene.wire.length });
      }
      const firstReference = !references.has(job.method) && variantId === 'cpu';
      if (firstReference) references.set(job.method, { frames, rows: run.rows });
      const reference = references.get(job.method);
      if (!reference) throw new Error('CPU reference is missing');
      const differences = frames.map((frame, index) => compareWallOutputs(frame, reference.frames[index]));
      run.outputExact = differences.every(d => d.exact);
      run.sameCurveShape = differences.every(d => d.sameCurveShape);
      run.changedFrames = differences.filter(d => !d.exact).length;
      run.maxVertexDistanceM = Math.max(0, ...differences.map(d => d.maxVertexDistanceM));
      run.maxCandidatePatchDisplacementBoundM = Math.max(0, ...differences.map(d => d.maxCandidatePatchDisplacementBoundM));
      run.unmatchedCandidates = Math.max(0, ...differences.map(d => d.unmatchedCandidates));
      run.discreteOutputChanges = differences.reduce((sum,d) => sum + d.discreteOutputChanges,0);
      run.maxF1Difference = Math.max(0, ...run.rows.map((row, i) => Math.abs(row.mapF1 - reference.rows[i].mapF1)));
      run.rows.forEach((row, i) => Object.assign(row, { parity: differences[i], referenceMapF1: reference.rows[i].mapF1 }));
      run.totalMs = run.rows.reduce((sum, row) => sum + row.ms, 0);
      run.requestMs = run.rows.reduce((sum, row) => sum + row.requestMs, 0);
      run.gpuCalls = Math.max(0, ...run.rows.map(row => row.gpuCalls));
      run.backendVerified = variantId === 'cpu' ? run.gpuCalls === 0 && run.rows.every(row => !row.backend.includes('WebGPU') && !['splineGpu','neuralGpu','densityGpu'].some(stage => row.device?.[stage]))
        : run.gpuCalls > 0 && run.rows.some(row => row.backend.includes('WebGPU')) && hasStages(run.initialized) && run.rows.every(row => hasStages(row.device));
      run.admissible = run.backendVerified && run.sameCurveShape && run.maxVertexDistanceM <= .002
        && run.maxF1Difference <= .000001 && (frames.every(f => Array.isArray(f.curves)) || run.outputExact);
      if (variantId !== 'cpu' && !run.admissible) run.rejection = !run.backendVerified ? 'GPU was unavailable or no GPU operation completed' : 'Output parity tolerance exceeded';
      const key = job.method + '/' + variantId;
      if ((firstReference || job.stage === 'measured' || run.rejection) && !retained.has(key)) {
        Object.assign(run, sampleBenchmarkFrames(frames, differences)); retained.add(key);
      }
      run.status = 'complete';
    } catch (error) {
      run.status = cancelled() ? 'cancelled' : hidden ? 'hidden' : run.unavailable ? 'unavailable' : 'failed';
      if (frames.length) Object.assign(run, sampleBenchmarkFrames(frames));
      run.error ??= error.message;
    } finally {
      clearTimeout(timeout); active?.close(); active = null; page?.removeEventListener('visibilitychange', visibility);
      run.elapsedMs = performance.now() - start;
    }
    return run;
  }
  const promise = (async () => {
    try {
      if (localSave) {
        const response = await fetch('/__benchmark/source');
        if (!response.ok) throw new Error('Cannot freeze benchmark source');
        record.source = await response.json();
      }
      for (const condition of cases) {
        await waitVisible(); emit({ phase: 'preparing', message: condition.id + ' · preparing one frozen measurement sequence' });
        const scene = await prepare(condition.input, (t, total) => { check(); emit({ phase: 'preparing', message: condition.id + ' · measurements ' + t + '/' + total }); });
        check();
        record.cases.push({ ...condition, domain: scene.domain, measurementBackend: scene.measurementBackend ?? 'browser',
          wireSha256: await sha(scene.wire), wires: scene.wire, wallGeneration: scene.wallGeneration,
          evaluationTruth: { role: 'evaluation only', wallModel: scene.wallModel, walls: scene.walls, truth: scene.truth } });
        const references = new Map(), retained = new Set(), rejected = new Map();
        for (const job of plan) {
          const candidate = job.method + '/' + job.variant.id;
          if (rejected.has(candidate)) {
            record.trials.push({ caseId: condition.id, ...job, status: 'skipped', reason: rejected.get(candidate) });
            record.completed++; continue;
          }
          let lastRun;
          for (let attempt = 0; attempt < 3; attempt++) {
            await waitVisible(); const run = lastRun = await trial(scene, condition, job, references, retained);
            run.attempt = attempt + 1;
            run.retryableInitialization = run.status === 'failed' && run.initialized === undefined && run.rows.length === 0 && run.error === 'Estimator worker failed';
            if ((run.status === 'hidden' || run.retryableInitialization) && attempt < 2) continue;
            if (run.retryableInitialization) run.retryExhausted = true;
            if (run.rejection || ['failed','unavailable'].includes(run.status)) rejected.set(candidate, run.rejection ?? run.error);
            break;
          }
          check();
          if (job.variant.id === 'cpu' && !references.has(job.method))
            throw new Error('CPU reference failed for ' + condition.id + ' / ' + job.method + ' after ' + lastRun.attempt + ' attempt(s): ' + (lastRun.error ?? lastRun.status) + '. Benchmark stopped before GPU comparisons.');
          record.completed++; record.summary = summarizeDeviceTrials(record.trials);
          await save(); emit({ phase: 'trial-complete', message: record.completed + '/' + record.total + ' trials complete' });
        }
      }
      if (localSave) {
        const response = await fetch('/__benchmark/source');
        if (!response.ok || encode(await response.json()) !== encode(record.source)) throw new Error('Source changed during benchmark; results cannot select a device');
      }
      record.status = 'complete';
    } catch (error) { record.status = cancelled() ? 'cancelled' : 'failed'; record.error = error.message; }
    finally {
      record.finished = new Date().toISOString(); record.summary = summarizeDeviceTrials(record.trials);
      await save(true); emit({ phase: record.status, message: record.status === 'complete' ? 'Benchmark complete' : record.error });
    }
    return record;
  })();
  return { promise, record, cancel() { controller.abort(); active?.close(); visibilityWake?.(); } };
}
