import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const targets = [
  ['original', new URL('../../drf/app.mjs', import.meta.url)],
  ['preview', new URL('../../preview/drf/app.mjs', import.meta.url)],
];

function fixture(source, { server = true, total = 6 } = {}) {
  const start = source.indexOf('async function runSweep('), end = source.indexOf("$('sweepButton').onclick", start);
  assert.ok(start >= 0 && end > start, 'Extract the actual app sweep handler');
  const writes = [], intervals = new Map(), allCallbacks = [], renderings = [], elements = new Map();
  let text = 'No sweep results yet.', nextTimer = 0, onProgress, resolve, reject, starts = 0;
  const status = {
    get textContent() { return text; },
    set textContent(value) { text = value; writes.push(value); },
  };
  elements.set('sweepStatus', status);
  const $ = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  const state = { generation: 7, connecting: false, server: server ? {} : null, sweep: null, sweepRuns: [] };
  const jobs = Array.from({ length: total }, (_, i) => ({ seed: i + 1, snapshots: 120 }));
  const handle = { promise: new Promise((yes, no) => { resolve = yes; reject = no; }) };
  const launch = (received, callback) => { assert.equal(received, jobs); starts++; onProgress = callback; return handle; };
  const context = vm.createContext({ state, $, settings: () => jobs[0], controls() {}, fillSettings() {},
    requestedServerJob: () => assert.fail('This fixture explicitly reconnects or uses browser workers'),
    startServerSweep: (_config, received, callback) => { assert.equal(server, true); return launch(received, callback); },
    startSweep: (received, callback) => { assert.equal(server, false); return launch(received, callback); },
    renderSweep: () => renderings.push(state.sweepRuns),
    setInterval: (callback, delay) => {
      assert.equal(delay, 1000, 'Only text updates are limited to once per second');
      const id = ++nextTimer; intervals.set(id, callback); allCallbacks.push(callback); return id;
    },
    clearInterval: id => intervals.delete(id),
  });
  vm.runInContext(source.slice(start, end), context);
  const done = context.runSweep(jobs, server ? 'existing-server-job' : undefined);
  assert.equal(starts, 1, 'UI sampling must not delay or repeat computation startup');
  return { state, jobs, status, writes, intervals, allCallbacks, renderings, done,
    tick: () => { for (const callback of [...intervals.values()]) callback(); },
    progress: (completed, results, progress) => onProgress({ completed, total, results, progress }),
    resolve, reject };
}

for (const [label, file] of targets) {
  const source = readFileSync(file, 'utf8');
  test(`${label}: interleaved sweep snapshots never replace the stable aggregate status`, async () => {
    const f = fixture(source);
    assert.equal(f.status.textContent, 'Running sweep · 0 / 6 complete');
    for (const id of [3, 0, 2, 1, 3, 2]) {
      f.progress(0, [], { type: 'sweep-progress', id, t: 120 - id * 10, total: 120 });
      f.tick();
    }
    f.progress(0, [], { type: 'connection', status: 'connected' });
    assert.equal(f.writes.length, 1, 'Repeated progress without a completed experiment must not rewrite the live region');
    assert.equal(f.renderings.length, 0, 'Snapshot notifications need no aggregate chart redraw');
    const first = [{ seed: 4 }], second = [...first, { seed: 1 }];
    f.progress(1, first, { type: 'sweep-result', id: 3 });
    assert.equal(f.state.sweepRuns, first, 'Store results immediately, independently of text refresh');
    f.progress(2, second, { type: 'sweep-result', id: 0 });
    assert.equal(f.state.sweepRuns, second); assert.equal(f.renderings.length, 2);
    assert.equal(f.writes.length, 1, 'Several completions within a refresh period are coalesced');
    f.tick();
    assert.equal(f.status.textContent, 'Running sweep · 2 / 6 complete');
    f.tick(); f.tick();
    assert.equal(f.writes.length, 2, 'Unchanged aggregate counts do not rewrite the DOM');
    assert.doesNotMatch(f.status.textContent, /experiment \d|snapshots|sample SD/);
    f.resolve({ results: second, cancelled: true }); await f.done;
    assert.equal(f.intervals.size, 0);
  });

  test(`${label}: browser-worker results use the same sampled status without delaying chart data`, async () => {
    const f = fixture(source, { server: false });
    const results = [{ seed: 1 }, { seed: 2 }];
    f.progress(2, results);
    assert.equal(f.state.sweepRuns, results); assert.equal(f.renderings.length, 1);
    assert.equal(f.status.textContent, 'Running sweep · 0 / 6 complete');
    f.tick(); assert.equal(f.status.textContent, 'Running sweep · 2 / 6 complete');
    f.resolve({ results, cancelled: true }); await f.done;
    assert.equal(f.intervals.size, 0);
  });

  for (const cancelled of [false, true]) {
    test(`${label}: ${cancelled ? 'cancellation' : 'completion'} is displayed immediately and stops status updates`, async () => {
      const f = fixture(source), results = f.jobs.slice(0, cancelled ? 2 : 6);
      f.progress(results.length, results, { type: 'sweep-result', id: 0 });
      assert.equal(f.status.textContent, 'Running sweep · 0 / 6 complete');
      f.resolve({ results, cancelled }); await f.done;
      assert.equal(f.status.textContent, `${cancelled ? 'Cancelled' : 'Complete'} · ${results.length} / 6 experiments`);
      assert.equal(f.state.sweepRuns, results); assert.equal(f.state.sweep, null); assert.equal(f.intervals.size, 0);
      const count = f.writes.length; f.tick(); assert.equal(f.writes.length, count);
    });
  }

  test(`${label}: a genuine sweep error appears immediately and clears the refresh timer`, async () => {
    const f = fixture(source);
    f.reject(new Error('Estimator failure')); await f.done;
    assert.equal(f.status.textContent, 'Sweep stopped: Estimator failure');
    assert.equal(f.state.sweep, null); assert.equal(f.intervals.size, 0);
    f.tick(); assert.equal(f.status.textContent, 'Sweep stopped: Estimator failure');
  });

  test(`${label}: stale sweep packets and timer callbacks cannot overwrite a replacement run`, async () => {
    const f = fixture(source), nextHandle = {}, nextResults = [{ seed: 99 }];
    f.progress(2, [{ seed: 1 }, { seed: 2 }], { type: 'sweep-result', id: 1 });
    f.state.generation++; f.state.sweep = nextHandle; f.state.sweepRuns = nextResults;
    f.status.textContent = 'Replacement run'; const count = f.writes.length;
    f.allCallbacks[0]();
    assert.equal(f.intervals.size, 0, 'A stale refresh callback also releases its timer');
    f.progress(5, f.jobs.slice(0, 5), { type: 'sweep-progress', id: 4, t: 120, total: 120 });
    assert.equal(f.writes.length, count); assert.equal(f.state.sweepRuns, nextResults);
    f.resolve({ results: f.jobs, cancelled: false }); await f.done;
    assert.equal(f.status.textContent, 'Replacement run'); assert.equal(f.state.sweep, nextHandle);
    assert.equal(f.state.sweepRuns, nextResults); assert.equal(f.intervals.size, 0);
  });

  test(`${label}: unconfirmed cancellation stays visible while further result data is received`, async () => {
    const f = fixture(source), first = [{ seed: 1 }];
    f.progress(1, first, { type: 'command-error', command: 'cancel', message: 'Network unavailable' });
    assert.match(f.status.textContent, /Cancellation was not confirmed: Network unavailable/);
    assert.equal(f.intervals.size, 0);
    const warning = f.status.textContent, count = f.writes.length, second = [...first, { seed: 2 }];
    f.progress(1, first, { type: 'sweep-progress', id: 2, t: 80, total: 120 });
    f.progress(2, second, { type: 'sweep-result', id: 1 }); f.tick();
    assert.equal(f.state.sweepRuns, second); assert.equal(f.renderings.length, 1);
    assert.equal(f.status.textContent, warning); assert.equal(f.writes.length, count);
    f.resolve({ results: second, cancelled: true }); await f.done;
    assert.equal(f.status.textContent, 'Cancelled · 2 / 6 experiments'); assert.equal(f.intervals.size, 0);
  });
}
