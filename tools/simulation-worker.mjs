import { parentPort, workerData } from 'node:worker_threads';
import { createRunEngine } from '../drf/run-engine.mjs';
import { createMessageEncoder, encodePacket } from '../drf/simulation-codec.mjs';
import { runExperiment } from '../drf/sweep.mjs';

function send(message, encode = encodePacket) {
  const bytes = encode(message);
  parentPort.postMessage({ type: message.type, mode: message.mode, next: message.next,
    t: message.t, total: message.total, id: message.id, message: message.message, bytes }, [bytes.buffer]);
}

if (workerData.mode === 'sweep') {
  parentPort.on('message', async message => {
    if (message.type !== 'run') return;
    try {
      const result = await runExperiment(message.input, (t, total) => {
        if (t === 1 || t % 10 === 0 || t === total) send({ type: 'sweep-progress', id: message.id, t, total });
      });
      const { final, ...record } = result;
      send({ type: 'sweep-result', id: message.id, result: record });
    } catch (error) { send({ type: 'error', message: error.message }); }
  });
} else {
  const transport = createMessageEncoder();
  const engine = createRunEngine({ emit: message => send(message, transport.encode),
    yieldTask: () => new Promise(resolve => setImmediate(resolve)) });
  parentPort.on('message', message => {
    try { Promise.resolve(engine.command(message)).catch(error => send({ type: 'error', message: error.message })); }
    catch (error) { send({ type: 'error', message: error.message }); }
  });
}
