import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticView } from '../../drf/diagnostic-ui.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const diagnostics = value => ({ diffusePerConfig: value, duplicateFraction: .2, theoremMean: 1, theoremMedian: .45,
  ratios: [value, value + 1], theoremNegative: 0, foldPrediction: .15, diffuseCounts: [value], predictedCounts: [value + 2] });
const run = (seed, roughness = 2) => ({ input: { seed, roughness, sigmaD: .1, snapshots: 8, vehicles: 3 }, diagnostics: diagnostics(seed) });
const context = () => ({ domain: [0, 80, -20, 50], t: 8, configs: [{ i: 1, j: 2 }, { i: 1, j: 3 }, { i: 2, j: 3 }] });
function fixture(overrides = {}) {
  const ids = ['diagnosticSourceSelect', 'configSelect', 'diagnosticSummary', 'diagnosticScope', 'diagnosticProfileStatus', 'diagnosticChart', 'profileChart', 'countChart'];
  // The controller only needs select options, text nodes and change events.
  // Rendering is exercised by the browser QA and the shared renderer suite.
  const document = { createElement: () => ({ value: '', textContent: '' }) };
  class Select extends EventTarget {
    constructor() { super(); this.ownerDocument = document; this.options = []; this._value = ''; this.disabled = false; }
    replaceChildren(...options) { this.options = options; this._value = options[0]?.value ?? ''; }
    set value(value) { this._value = this.options.some(option => option.value === value) ? value : ''; }
    get value() { return this._value; }
    get selectedOptions() { return this.options.filter(option => option.value === this._value); }
  }
  const elements = Object.fromEntries(ids.map(id => [id, ['diagnosticSourceSelect', 'configSelect'].includes(id) ? new Select() : { textContent: '' }]));
  const calls = { hist: [], counts: [], profiles: [], source: [], sweepProfile: [], comparisonProfile: [] };
  const view = createDiagnosticView({ elements,
    drawHistogram: (_el, ratios) => calls.hist.push(ratios),
    drawCounts: (_el, counts, predicted) => calls.counts.push([counts, predicted]),
    drawProfile: (_el, cells, domain) => calls.profiles.push([cells, domain]),
    setMathText: (el, parts) => { el.textContent = parts.map(part => typeof part === 'string' ? part : part.tex).join(''); },
    loadSweepSource: async selected => { calls.source.push(selected); return context(); },
    loadSweepProfile: async (selected, index) => { calls.sweepProfile.push([selected, index]); return { cells: [{ source: selected.input.seed, pair: index }] }; },
    loadComparisonProfile: async (comparison, index) => { calls.comparisonProfile.push([comparison, index]); return { cells: [{ source: 'comparison', pair: index }] }; },
    ...overrides,
  });
  const select = (id, value) => { elements[id].value = value; elements[id].dispatchEvent(new Event('change')); };
  return { elements, calls, view, select };
}

test('a sweep-only session exposes its experiment, all pairs and real diagnostic arrays', async () => {
  const f = fixture(), first = run(7);
  f.view.render({ sweepRuns: [first], visible: true }); await settle();
  assert.equal(f.elements.diagnosticSourceSelect.disabled, false);
  assert.match(f.elements.diagnosticSourceSelect.selectedOptions[0].textContent, /range SD 0\.1 m.*roughness 2 deg.*seed 7/);
  assert.equal(f.elements.configSelect.disabled, false);
  assert.deepEqual([...f.elements.configSelect.options].map(option => option.textContent), ['Vehicles 1–2', 'Vehicles 1–3', 'Vehicles 2–3']);
  assert.equal(f.calls.hist.at(-1), first.diagnostics.ratios);
  assert.equal(f.calls.counts.at(-1)[0], first.diagnostics.diffuseCounts);
  assert.deepEqual(f.calls.profiles.at(-1)[0], [{ source: 7, pair: 0 }]);
  assert.match(f.elements.diagnosticScope.textContent, /all vehicle pairs through snapshot 8.*selected pair at snapshot 8/);
  assert.equal(f.calls.source.length, 1);
});

test('adding/reordering completed sweep results preserves the explicitly selected seed', async () => {
  const f = fixture(), seed7 = run(7), seed1 = run(1), seed3 = run(3);
  f.view.render({ sweepRuns: [seed7], visible: true }); await settle();
  const selection = f.elements.diagnosticSourceSelect.value;
  f.view.render({ sweepRuns: [seed3, seed1, seed7], visible: true }); await settle();
  assert.equal(f.elements.diagnosticSourceSelect.value, selection);
  assert.equal(f.calls.source.length, 1, 'No geometry reload for resize or result arrival');
  assert.equal(f.calls.sweepProfile.length, 1, 'No duplicate profile computation');
  assert.equal(f.calls.hist.at(-1), seed7.diagnostics.ratios);
});

test('switching a vehicle pair updates only that profile, with the accumulated scope explicit', async () => {
  const f = fixture(), selected = run(2);
  f.view.render({ sweepRuns: [selected], visible: true }); await settle();
  f.select('configSelect', '2'); await settle();
  assert.deepEqual(f.calls.profiles.at(-1)[0], [{ source: 2, pair: 2 }]);
  assert.equal(f.calls.source.length, 1);
  assert.equal(f.calls.hist.at(-1), selected.diagnostics.ratios);
  assert.equal(f.calls.counts.at(-1)[0], selected.diagnostics.diffuseCounts);
});

test('comparison and sweep diagnostics remain separate and comparison snapshot changes refresh its profile', async () => {
  const f = fixture(), sweep = run(9), comparison = { ...context(), key: 'generation-3', input: { seed: 1, roughness: 2 }, diagnostics: diagnostics(100) };
  f.view.render({ comparison, sweepRuns: [sweep], visible: true }); await settle();
  assert.match(f.elements.diagnosticSourceSelect.value, /^main:/);
  assert.equal(f.calls.hist.at(-1), comparison.diagnostics.ratios);
  f.select('diagnosticSourceSelect', [...f.elements.diagnosticSourceSelect.options].find(o => o.value.startsWith('sweep:')).value); await settle();
  assert.equal(f.calls.hist.at(-1), sweep.diagnostics.ratios);
  f.select('diagnosticSourceSelect', 'main:generation-3'); await settle();
  const updated = { ...comparison, t: 9, diagnostics: diagnostics(200) };
  f.view.render({ comparison: updated, sweepRuns: [sweep], visible: true }); await settle();
  assert.equal(f.calls.hist.at(-1), updated.diagnostics.ratios);
  assert.equal(f.calls.comparisonProfile.at(-1)[0].t, 9);
});

test('slow profile responses cannot replace a newly selected experiment or pair', async () => {
  const profiles = new Map(), f = fixture({ loadSweepProfile: (selected, index) => {
    const value = deferred(); profiles.set(`${selected.input.seed}:${index}`, value); return value.promise;
  } });
  f.view.render({ sweepRuns: [run(1), run(2)], visible: true }); await settle();
  f.select('configSelect', '1'); await settle();
  profiles.get('1:1').resolve({ cells: ['new pair'] }); await settle();
  profiles.get('1:0').resolve({ cells: ['old pair'] }); await settle();
  assert.deepEqual(f.calls.profiles.at(-1)[0], ['new pair']);
  f.select('diagnosticSourceSelect', f.elements.diagnosticSourceSelect.options[1].value); await settle();
  profiles.get('2:0').resolve({ cells: ['new experiment'] }); await settle();
  assert.deepEqual(f.calls.profiles.at(-1)[0], ['new experiment']);
});

test('a slow source response and an in-flight profile are ignored after source reset', async () => {
  const sources = new Map(), profiles = new Map(), f = fixture({
    loadSweepSource: selected => { const value = deferred(); sources.set(selected.input.seed, value); return value.promise; },
    loadSweepProfile: selected => { const value = deferred(); profiles.set(selected.input.seed, value); return value.promise; },
  });
  f.view.render({ sweepRuns: [run(1), run(2)], visible: true }); await settle();
  f.select('diagnosticSourceSelect', f.elements.diagnosticSourceSelect.options[1].value); await settle();
  sources.get(2).resolve(context()); await settle();
  sources.get(1).resolve({ ...context(), configs: [{ i: 7, j: 8 }] }); await settle();
  assert.equal(f.elements.configSelect.options[0].textContent, 'Vehicles 1–2');
  f.view.reset(); profiles.get(2).resolve({ cells: ['obsolete'] }); await settle();
  assert.equal(f.elements.diagnosticSourceSelect.disabled, true);
  assert.equal(f.elements.configSelect.disabled, true);
  assert.deepEqual(f.calls.profiles.at(-1)[0], []);
  assert.match(f.elements.diagnosticSummary.textContent, /Run comparison or complete a parameter sweep/);
});

test('zero roughness is identified as inapplicable ratio testing, not a missing run', async () => {
  const f = fixture(), smooth = run(4, 0); smooth.diagnostics.ratios = [];
  f.view.render({ sweepRuns: [smooth], visible: true }); await settle();
  assert.match(f.elements.diagnosticSummary.textContent, /Zero roughness.*not applicable/);
  assert.doesNotMatch(f.elements.diagnosticSummary.textContent, /No diagnostics yet/);
  assert.equal(f.elements.configSelect.disabled, false);
  assert.deepEqual(f.calls.hist.at(-1), []);
});

test('hidden diagnostics defer profile work, then reuse the active profile across redraws', async () => {
  const f = fixture(), selected = run(3);
  f.view.render({ sweepRuns: [selected], visible: false }); await settle();
  assert.equal(f.calls.source.length, 0);
  f.view.render({ sweepRuns: [selected], visible: true }); await settle();
  f.view.render({ sweepRuns: [selected], visible: true }); await settle();
  assert.equal(f.calls.source.length, 1); assert.equal(f.calls.sweepProfile.length, 1);
  assert.deepEqual(f.calls.profiles.at(-1)[0], [{ source: 3, pair: 0 }]);
});

test('source and profile errors are visible without silently showing another experiment', async () => {
  const source = fixture({ loadSweepSource: async () => { throw new Error('source failed'); } });
  source.view.render({ sweepRuns: [run(1)], visible: true }); await settle();
  assert.match(source.elements.diagnosticProfileStatus.textContent, /source failed/);
  assert.equal(source.elements.configSelect.disabled, true);
  const profile = fixture({ loadSweepProfile: async () => { throw new Error('pair failed'); } });
  profile.view.render({ sweepRuns: [run(1)], visible: true }); await settle();
  assert.match(profile.elements.diagnosticProfileStatus.textContent, /pair failed/);
  assert.deepEqual(profile.calls.profiles.at(-1)[0], []);
});
