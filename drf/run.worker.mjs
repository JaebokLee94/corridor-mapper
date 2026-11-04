import { createRunEngine } from './run-engine.mjs?v=20261104-truthcache2';

const engine = createRunEngine({ emit(message) {
  // Only per-frame readout buffers move to the page; accumulator buffers stay here.
  const transfer = message.type === 'frame'
    ? [message.frame.Dbar.buffer, message.frame.betaHat.buffer] : [];
  globalThis.postMessage(message, transfer);
} });

globalThis.onmessage = async ({ data }) => {
  try {
    const allowed = data.type === 'start' ? ['type', 'requestId', 'input', 'single'] : ['type', 'requestId'];
    if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('Unexpected run command input');
    await engine.command(data);
  } catch (error) {
    globalThis.postMessage({ type: 'error', requestId: data?.requestId, message: error.message });
  }
};
