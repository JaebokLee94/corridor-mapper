import { normalizeInput } from './scenario.mjs?v=20261104-truthcache1';
import { prepareScenario as generateScenario } from './prepare-scenario.mjs?v=20261104-background2';
import { createGrid, createField } from './field.mjs';
import { MethodComparison, METHOD_PROTOCOL } from './comparison.mjs';
import { createPSPTEvaluator } from './pspt-evaluate.mjs';

/** Yield within the worker so pause/cancel commands run between snapshots.
 * No page acknowledgement, animation callback or parent timer is required.
 */
export function yieldWorkerTask() {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close(); channel.port2.close(); resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Autonomous run controller shared by the module and offline workers.
 * Input: normalized scenario settings; inference receives only wire[t] and sigmaD.
 * Output: prepared scenario/grid, then one frame/evaluation per causal prefix.
 * The existing numerical kernels are unchanged. Work is the same as a foreground
 * run, but field and method calculations are sequential in this worker. Memory is
 * O(scenario + grid + estimator/evaluator state); frame history belongs to the UI.
 * emit must be nonblocking: the controller never waits for the page to consume it.
 */
export function createRunEngine({ emit, yieldTask = yieldWorkerTask } = {}) {
  if (typeof emit !== 'function') throw new TypeError('A result emitter is required');
  let epoch = 0, active = null;
  const send = (run, type, value = {}) => {
    if (active === run && run.epoch === epoch) emit({ type, requestId: run.requestId, ...value });
  };
  const status = (run, mode) => send(run, 'status', { mode, next: run.next, total: run.input.snapshots });
  const failed = (run, error) => {
    if (active !== run || run.epoch !== epoch) return;
    run.target = 'failed'; send(run, 'error', { message: error.message });
  };

  async function pump(run) {
    if (active !== run || run.epoch !== epoch || !run.scenario || run.busy) return;
    run.busy = true;
    try {
      while (active === run && run.epoch === epoch && (run.target === 'running' || run.steps > 0)) {
        // Truth and future observations stay on the generation/evaluation side.
        // Neither inference kernel receives the scenario or the run settings.
        const wire = run.scenario.wire[run.next];
        const frame = run.field.step(wire);
        frame.methods = run.estimator.step(wire);
        frame.candidates = frame.methods.guarded.candidates;
        frame.psptMs = frame.methods.guarded.ms; frame.method = 'guarded-tuned';
        const guarded = run.guardedEvaluator.step(frame, null, frame.methods.guarded.bridges);
        const baseline = run.baselineEvaluator.step({ ...frame, method: 'baseline-b',
          candidates: frame.methods.baseline.candidates }, guarded, frame.methods.baseline.bridges);
        const evaluation = { ...guarded, methods: { guarded, baseline } };
        run.next++;
        if (run.steps > 0) run.steps--;
        send(run, 'frame', { frame, evaluation, next: run.next });
        if (active !== run || run.epoch !== epoch) return;
        if (run.next === run.scenario.wire.length) {
          run.target = 'done'; status(run, 'done'); return;
        }
        await yieldTask();
      }
      if (active === run && run.epoch === epoch && run.target === 'paused') status(run, 'paused');
    } catch (error) { failed(run, error); }
    finally { run.busy = false; }
  }

  async function start(message) {
    if (active && !['done', 'cancelled', 'failed'].includes(active.target))
      throw new Error('Cancel the current run before starting another');
    const input = normalizeInput(message.input);
    if (input.sigmaD === 0) throw new Error('Both methods require range SD σd > 0.');
    const run = { epoch: ++epoch, requestId: message.requestId, input, next: 0,
      target: message.single ? 'paused' : 'running', steps: message.single ? 1 : 0, busy: false };
    active = run; status(run, 'running');
    try {
      const scenario = await generateScenario(input, (t, total) => {
        if (active !== run || run.epoch !== epoch) throw new Error('Cancelled');
        send(run, 'progress', { t, total });
      }, { onPhase: phase => send(run, 'preparation', { phase }) });
      if (active !== run || run.epoch !== epoch) return;
      run.scenario = scenario;
      run.grid = createGrid(input.grid, input.grid, scenario.domain);
      run.field = createField(run.grid, { band: input.band, perimeter: input.perimeter });
      run.estimator = new MethodComparison({ sigmaR: input.sigmaD });
      run.guardedEvaluator = createPSPTEvaluator(scenario, run.grid);
      run.baselineEvaluator = createPSPTEvaluator(scenario, run.grid);
      send(run, 'prepared', { scenario, grid: run.grid, protocol: METHOD_PROTOCOL });
      await pump(run);
    } catch (error) { failed(run, error); }
  }

  function command(message) {
    if (message.type === 'start') return start(message);
    const run = active;
    if (!run || message.requestId !== run.requestId) return;
    if (message.type === 'cancel') {
      if (['done', 'cancelled', 'failed'].includes(run.target)) return;
      run.target = 'cancelled'; run.steps = 0; status(run, 'cancelled'); epoch++; return;
    }
    if (['done', 'cancelled', 'failed'].includes(run.target)) return;
    if (message.type === 'pause') {
      run.target = 'paused'; run.steps = 0;
      if (run.scenario && !run.busy) status(run, 'paused');
    } else if (message.type === 'resume') {
      run.target = 'running'; run.steps = 0; status(run, 'running'); return pump(run);
    } else if (message.type === 'step') {
      if (run.target !== 'paused' || run.busy || !run.scenario) return;
      run.steps = 1; status(run, 'running'); return pump(run);
    } else throw new Error('Unknown run command');
  }
  return { command };
}
