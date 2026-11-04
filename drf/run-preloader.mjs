import { truthCacheKey } from './truth-cache.mjs';

function identity(input) {
  if (!input || !Number.isInteger(input.seed) || input.seed < 1 || input.seed > 10
    || !Number.isInteger(input.vehicles) || input.vehicles < 2 || input.vehicles > 10
    || !Number.isInteger(input.snapshots) || input.snapshots < 1 || input.snapshots > 120) return null;
  try { return `${truthCacheKey(input)}|${input.vehicles}|${input.snapshots}`; }
  catch { return null; }
}

/** Own at most one idle worker for the selected normalized input. It receives
 * only warm-truth, never start: downloading/decoding stored truth must not run
 * measurements or estimation before the user's Run action. take() transfers
 * ownership to the caller; subsequent changes/disposal cannot stop that run.
 * State is O(1); the worker's bounded truth cache owns the potentially large data.
 */
export function createRunPreloader({ createWorker, delay = 180, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof createWorker !== 'function') throw new TypeError('A worker factory is required');
  let selected = null, timer = null, worker = null;

  function clearPending() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }
  function dispose() {
    clearPending();
    const previous = worker;
    selected = null; worker = null;
    previous?.terminate();
  }
  function schedule(input) {
    const key = identity(input);
    if (key === selected && key !== null) return;
    dispose();
    if (key === null) return;
    selected = key;
    const requested = { ...input };
    timer = setTimer(() => {
      timer = null;
      if (selected !== key) return;
      try {
        const created = createWorker();
        worker = created;
        created.onerror = () => { if (worker === created) dispose(); };
        created.postMessage({ type: 'warm-truth', input: requested });
      } catch {
        // Warmup is optional. Run creates a fresh worker after any warmup failure.
        dispose();
      }
    }, delay);
  }
  function take(input) {
    clearPending();
    if (selected !== identity(input) || !worker) { dispose(); return null; }
    const ready = worker;
    worker = null; selected = null;
    ready.onerror = null;
    return ready;
  }
  return { schedule, take, dispose };
}
