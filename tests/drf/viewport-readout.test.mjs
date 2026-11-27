import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrid } from '../../drf/field.mjs';
import { createViewportReadout } from '../../drf/viewport-readout.mjs';

const baseGrid = createGrid(10, 10, [-.5, 9.5, -.5, 9.5]);
const bounds = [-4.8, 15.1, -.22, 7];
const input = () => ({baseGrid, bounds, numerical:{band:3, perimeter:'ramanujan'},
  wire:[1,2,3,4].map(t => ({t, configs:[]})), t:2});
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const workers = [], errors = [];
  let redraws = 0;
  const reader = createViewportReadout(() => {
    const handle = {pending:[], stopped:0,
      request(message) { return new Promise((resolve, reject) => handle.pending.push({message, resolve, reject})); },
      stop() { handle.stopped++; }};
    workers.push(handle);
    return handle;
  }, () => redraws++, error => errors.push(error.message));
  return {reader, workers, errors, redraws:() => redraws};
}

test('reads ordered measured prefixes, caches backwards seeks and reuses equivalent camera cells', async () => {
  const {reader, workers, errors, redraws} = harness(), run = input();
  Object.defineProperty(run.wire, 3, {get() { throw new Error('future wire accessed'); }});
  assert.equal(reader.read(run), undefined);
  assert.equal(reader.read({...run, bounds:[-4.7, 15.2, -.13, 7.1]}), undefined);
  const worker = workers[0];
  assert.equal(workers.length, 1); assert.equal(worker.pending.length, 1);
  const init = worker.pending[0];
  assert.deepEqual(init.message, {type:'initDisplay', grid:{nx:10, ny:10, domain:baseGrid.domain},
    numerical:{band:3, perimeter:'ramanujan', viewBounds:[-5.5, 15.5, -.5, 7.5]}});
  init.resolve({type:'initialized'}); await tick();
  assert.deepEqual(worker.pending[1].message, {type:'step', snapshot:run.wire[0]});
  assert.equal(reader.read({...run, t:3}), undefined);
  assert.equal(worker.pending.length, 2);
  worker.pending[1].resolve({type:'frame', t:1, Q:12, requestId:2}); await tick();
  assert.equal(redraws(), 0);
  assert.deepEqual(worker.pending[2].message, {type:'step', snapshot:run.wire[1]});
  const historical = reader.read({...run, t:1});
  assert.deepEqual(historical, {t:1, Q:12});
  worker.pending[2].resolve({type:'frame', t:2, Q:23}); await tick();
  assert.equal(worker.pending.length, 3, 'a backward seek stops further stepping');
  assert.equal(redraws(), 0);
  assert.equal(reader.read({...run,t:1}), historical);
  assert.deepEqual(reader.read(run), {t:2, Q:23});
  assert.equal(reader.read({...run,t:3}), undefined);
  assert.deepEqual(worker.pending[3].message, {type:'step', snapshot:run.wire[2]});
  worker.pending[3].resolve({type:'frame', t:3, Q:37}); await tick();
  assert.deepEqual(reader.read({...run,t:3}), {t:3, Q:37});
  assert.equal(redraws(), 1); assert.deepEqual(errors, []);
  reader.reset();
  assert.equal(worker.stopped, 1);
});

test('changing cells or runs and resetting fence old initializations, results and errors', async () => {
  const {reader, workers, errors, redraws} = harness(), run = input();
  reader.read(run);
  const panned = {...run, bounds:[-20, -15, -2, -1]};
  reader.read(panned);
  workers[0].pending[0].resolve({type:'initialized'}); await tick();
  assert.equal(workers[0].stopped, 1); assert.equal(workers[0].pending.length, 1);
  workers[1].pending[0].resolve({type:'initialized'}); await tick();
  const otherRun = {...panned, wire:run.wire.slice(), t:1};
  reader.read(otherRun);
  workers[1].pending[1].reject(new Error('old pan failed')); await tick();
  assert.equal(workers[1].stopped, 1); assert.deepEqual(errors, []);
  workers[2].pending[0].resolve({type:'initialized'}); await tick();
  reader.reset();
  workers[2].pending[1].resolve({type:'frame', t:1, Q:99}); await tick();
  assert.equal(redraws(), 0); assert.deepEqual(errors, []);
  assert.equal(reader.read(otherRun), undefined);
  assert.equal(workers.length, 4);
  reader.read({...otherRun, wire:[], t:0});
  assert.equal(workers[3].stopped, 1);
});

test('current worker and input errors are reported once and corrected views can restart', async () => {
  const {reader, workers, errors} = harness(), run = input();
  const invalid = {...run, bounds:[1, 0, 1, 2]};
  reader.read(invalid); reader.read(invalid);
  assert.equal(errors.length, 1); assert.match(errors[0], /viewBounds/); assert.equal(workers.length, 0);
  reader.read(run);
  workers[0].pending[0].reject(new Error('worker initialization failed')); await tick();
  reader.read(run); reader.read(run);
  assert.equal(workers.length, 1); assert.equal(workers[0].stopped, 1);
  assert.equal(errors[1], 'worker initialization failed'); assert.equal(errors.length, 2);
  reader.read({...run, numerical:{band:'full'}});
  assert.equal(workers.length, 2);
  workers[1].pending[0].resolve({type:'initialized'}); await tick();
  workers[1].pending[1].resolve({type:'frame', t:2}); await tick();
  assert.match(errors[2], /unexpected viewport snapshot/);
  reader.reset(); assert.equal(workers[1].stopped, 1);
});
