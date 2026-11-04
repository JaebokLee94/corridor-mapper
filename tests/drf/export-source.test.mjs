import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sweepCsv } from '../../drf/sweep-export.mjs';

const source = readFileSync(new URL('../../drf/app.mjs', import.meta.url), 'utf8');
const section = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing shipped export handler boundary: ${start}`);
  return source.slice(a, b);
};
const protocol = {
  guarded: { name: 'Guarded PSPT', threshold: 3.25, tuning: { id: 'saved-pspt' }, revision: 'saved-implementation' },
  baseline: { name: 'Fixed-fragment B', threshold: 11.5, tuning: { id: 'saved-b' } },
};
const sweepRun = seed => ({ input: { seed, snapshots: 8, vehicles: 3, sigmaD: .1, roughness: 2 }, protocol,
  methods: { guarded: { summary: { precision: 1, recall: .7 } }, baseline: { summary: { precision: .8, recall: .75 } } } });
const comparison = () => ({ valid: true, frames: [{ t: 1, methods: { guarded: { candidates: [], ms: 1 }, baseline: { candidates: [], ms: 2 } } }],
  evaluations: [{ methods: { guarded: {}, baseline: {} } }], protocol });
function fixture(initial = {}, overrides = {}) {
  const state = { valid: false, frames: [], evaluations: [], sweepRuns: [], protocol: null, ...initial };
  const select = { options: [], value: '', disabled: false, replaceChildren(...options) { this.options = options; this.value = options[0]?.value ?? ''; } };
  const elements = { exportSourceSelect: select, heatField: { value: 'Dbar' }, exportJson: {}, exportCsv: {}, exportPng: {}, exportCsvDescription: {}, exportPngDescription: {} };
  const downloads = [], notices = [], pngSources = [], aggregationInputs = [];
  const parameters = { state, $: id => elements[id], document: { createElement: () => ({}) }, provenance: {}, Blob,
    aggregateRuns: runs => { aggregationInputs.push(runs); return runs.map(run => ({ seed: run.input.seed })); },
    sweepCsv, psptSnapshotCsv: () => 'snapshot,precision,pspt_ms\r\n1,1,2\r\n',
    download: (blob, name) => downloads.push({ blob, name }),
    sweepPng: async rows => { pngSources.push({ kind: 'sweep', rows }); return new Blob(['sweep PNG']); },
    densityMap: { png: async () => { pngSources.push({ kind: 'density' }); return new Blob(['density PNG']); } },
    contrastMap: { png: async () => { pngSources.push({ kind: 'contrast' }); return new Blob(['contrast PNG']); } },
    png300dpi: async blob => blob, notice: message => notices.push(message), ...overrides,
  };
  const code = section('function renderExportControls()', 'function updateRunProgress()')
    + section('const jsonValue =', 'const chartResize =') + '\nreturn renderExportControls;';
  const render = new Function(...Object.keys(parameters), code)(...Object.values(parameters));
  render();
  return { state, elements, select, downloads, notices, pngSources, aggregationInputs, render };
}

test('sweep-only results activate CSV and PNG and export their sweep source without a comparison', async () => {
  const f = fixture({ sweepRuns: [sweepRun(4), sweepRun(5)] }, { psptSnapshotCsv: () => assert.fail('No comparison snapshots exist') });
  assert.equal(f.select.value, 'sweep'); assert.equal(f.select.disabled, false);
  for (const id of ['exportJson', 'exportCsv', 'exportPng']) assert.equal(f.elements[id].disabled, false);
  assert.match(f.elements.exportCsvDescription.textContent, /per seed and method/);
  assert.match(f.elements.exportPngDescription.textContent, /sweep recall charts/);
  f.elements.exportCsv.onclick();
  assert.equal(f.downloads[0].name, 'echomap-parameter-sweep.csv');
  assert.equal((await f.downloads[0].blob.text()).trim().split('\r\n').length, 5);
  await f.elements.exportPng.onclick();
  assert.equal(f.downloads[1].name, 'echomap-parameter-sweep-300dpi.png');
  assert.equal(await f.downloads[1].blob.text(), 'sweep PNG');
  assert.equal(f.aggregationInputs.at(-1), f.state.sweepRuns);
  assert.equal(f.pngSources[0].kind, 'sweep'); assert.equal(f.elements.exportPng.disabled, false);
});

test('mixed results preserve the chosen export source across control redraws and route both formats correctly', async () => {
  const f = fixture({ ...comparison(), sweepRuns: [sweepRun(9)] });
  assert.deepEqual(f.select.options.map(option => option.value), ['comparison', 'sweep']);
  assert.equal(f.select.value, 'comparison');
  f.select.value = 'sweep'; f.select.onchange(); f.render();
  assert.equal(f.select.value, 'sweep');
  f.elements.exportCsv.onclick(); assert.equal(f.downloads.at(-1).name, 'echomap-parameter-sweep.csv');
  await f.elements.exportPng.onclick(); assert.equal(f.pngSources.at(-1).kind, 'sweep');
  f.select.value = 'comparison'; f.select.onchange();
  assert.match(f.elements.exportCsvDescription.textContent, /per snapshot and method/);
  assert.match(f.elements.exportPngDescription.textContent, /current snapshot/);
  f.elements.exportCsv.onclick();
  assert.equal(f.downloads.at(-1).name, 'echomap-method-comparison.csv');
  const csv = await f.downloads.at(-1).blob.text();
  assert.match(csv, /guarded,3\.25,saved-pspt/); assert.match(csv, /saved-implementation/);
  await f.elements.exportPng.onclick(); assert.equal(f.pngSources.at(-1).kind, 'density');
  f.elements.heatField.value = 'betaHat'; await f.elements.exportPng.onclick();
  assert.equal(f.pngSources.at(-1).kind, 'contrast');
});

test('exports are disabled when no results exist, and removed sweep sources fall back to comparison', () => {
  const f = fixture();
  assert.equal(f.select.disabled, true); assert.equal(f.select.value, '');
  for (const id of ['exportJson', 'exportCsv', 'exportPng']) assert.equal(f.elements[id].disabled, true);
  Object.assign(f.state, comparison(), { sweepRuns: [sweepRun(1)] }); f.render();
  f.select.value = 'sweep'; f.select.onchange();
  f.state.sweepRuns = []; f.render();
  assert.equal(f.select.value, 'comparison'); assert.equal(f.elements.exportCsv.disabled, false);
});

test('PNG errors are reported and release the temporary disabled button', async () => {
  const f = fixture({ sweepRuns: [sweepRun(1)] }, { sweepPng: async () => { throw new Error('Image generation failed'); } });
  await f.elements.exportPng.onclick();
  assert.deepEqual(f.notices, ['PNG export failed: Image generation failed']);
  assert.equal(f.downloads.length, 0); assert.equal(f.elements.exportPng.disabled, false);
});
