import { preparePublicScenario } from './public-measure.mjs';
import { createRunEngine } from './run-engine.mjs?v=20261112-wmf-fleet';
import { warmTruthCache } from './prepare-scenario.mjs?v=20261104-background2';
import { normalizeInput } from './scenario.mjs?v=20261104-truthcache1';
import { truthCacheKey } from './truth-cache.mjs';

const identity = raw => {
  const input = normalizeInput(raw);
  return `${truthCacheKey(input)}|${input.vehicles}|${input.snapshots}`;
};
let warming, pendingStart;

const engine = createRunEngine({ prepare:preparePublicScenario, emit(message) {
  // Only per-frame readout buffers move to the page; accumulator buffers stay here.
  const transfer = message.type === 'frame'
    ? [message.frame.Dbar.buffer, message.frame.betaHat.buffer] : [];
  globalThis.postMessage(message, transfer);
} });

globalThis.onmessage = async ({ data }) => {
  try {
    if (data.type === 'warm-truth') {
      if (Object.keys(data).some(key => !['type', 'input'].includes(key))) throw new Error('Unexpected preload input');
      const pending = { key: identity(data.input), promise: warmTruthCache(data.input) };
      warming = pending;
      const hit = await pending.promise;
      if (warming === pending) globalThis.postMessage({ type: 'truth-warmed', hit });
      return;
    }
    const allowed = data.type === 'start' ? ['type', 'requestId', 'input', 'single'] : ['type', 'requestId'];
    if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('Unexpected run command input');
    if (data.type === 'cancel' && pendingStart?.requestId === data.requestId) {
      pendingStart = null;
      globalThis.postMessage({ type: 'status', requestId: data.requestId, mode: 'cancelled', next: 0 });
      return;
    }
    if (data.type === 'start' && warming?.key === identity(data.input)) {
      const pending = pendingStart = { requestId: data.requestId };
      globalThis.postMessage({ type: 'preparation', requestId: data.requestId, phase: 'loading' });
      // Let a preload miss settle before normal preparation retries with generation.
      // A different physical setting never waits for an unrelated preload.
      await warming.promise;
      if (pendingStart !== pending) return;
      pendingStart = null;
    }
    await engine.command(data);
  } catch (error) {
    globalThis.postMessage({ type: 'error', requestId: data?.requestId, message: error.message });
  }
};
