import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepCsv } from '../../drf/sweep-export.mjs';

// Small RFC-4180 reader so assertions cover escaped commas/quotes/newlines.
function readCsv(csv) {
  const rows = [], row = []; let cell = '', quoted = false;
  for (let i = 1; i < csv.length; i++) {
    const char = csv[i];
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\r' && csv[i + 1] === '\n') { row.push(cell); rows.push(row.splice(0)); cell = ''; i++; }
    else cell += char;
  }
  const [header, ...values] = rows;
  return { header, values, objects: values.map(values => Object.fromEntries(header.map((key, i) => [key, values[i]]))) };
}
const example = seed => ({ input: { seed, scene: 'layered', wallSide: 'both', vehicles: 10, snapshots: 120,
  sigmaP: .1, sigmaD: .2, sigmaM: 6, deltaM: 20, sigmaDGeometry: .33, deltaD: 4,
  roughness: 2, lambda0: 10, cellStep: .02, resolution: 0, specular: true, grid: 150, band: 4, perimeter: 'exact' },
  protocol: {
    guarded: { name: 'Guarded PSPT', threshold: 6.650397183049193, tuning: { id: 'saved-tuning' }, revision: 'saved-revision' },
    baseline: { name: 'Fixed-fragment B', threshold: 29.108623616301394, tuning: { id: 'baseline-tuning' } },
  },
  methods: {
    guarded: { summary: { precision: 1, recall: .7384927362515621, p95: .089, offwall: 0, supportedCount: 72, Q: 103573 } },
    baseline: { summary: { precision: .789, recall: .717, p95: 2.413, offwall: .211, supportedCount: 95, Q: 103573 } },
  },
});

test('sweep CSV exports one full-precision row per experiment and method with saved provenance', () => {
  const runs = [example(9), example(10)], before = JSON.stringify(runs), csv = sweepCsv(runs);
  assert.equal(csv.charCodeAt(0), 0xfeff); assert.ok(csv.endsWith('\r\n'));
  const result = readCsv(csv);
  assert.equal(result.objects.length, 4);
  assert.deepEqual(result.objects.map(row => [row.experiment_index, row.method, row.input_seed]),
    [['1', 'guarded', '9'], ['1', 'baseline', '9'], ['2', 'guarded', '10'], ['2', 'baseline', '10']]);
  const row = result.objects[0];
  assert.equal(row.selection_threshold, '6.650397183049193');
  assert.equal(row.threshold_source, 'saved-tuning'); assert.equal(row.implementation_revision, 'saved-revision');
  assert.equal(row.summary_recall, '0.7384927362515621', 'Do not replace fractions by rounded UI percentages');
  assert.equal(row.summary_Q, '103573');
  for (const [key, value] of Object.entries(runs[0].input)) assert.equal(row[`input_${key}`], String(value), key);
  assert.equal(JSON.stringify(runs), before, 'Export leaves experiment data intact');
});

test('missing metrics stay empty while zero and nonfinite failures remain distinguishable', () => {
  const run = example(1);
  run.methods.guarded.summary = { precision: null, recall: 0, p95: Infinity, offwall: NaN, medianError: -Infinity, missing: undefined };
  delete run.protocol;
  const row = readCsv(sweepCsv([run])).objects[0];
  assert.equal(row.summary_precision, ''); assert.equal(row.summary_missing, ''); assert.equal(row.summary_recall, '0');
  assert.equal(row.summary_p95, 'Infinity'); assert.equal(row.summary_offwall, 'NaN'); assert.equal(row.summary_medianError, '-Infinity');
  assert.equal(row.selection_threshold, ''); assert.equal(row.threshold_source, ''); assert.equal(row.implementation_revision, '');
});

test('every additional input and summary field is included with proper CSV escaping', () => {
  const first = example(1), second = example(2);
  first.protocol.guarded.name = 'PSPT, "saved"\r\nvariant';
  second.input.extraCondition = 'a,b'; second.methods.baseline.summary.extraMetric = .123456789012345;
  const parsed = readCsv(sweepCsv([first, second]));
  assert.equal(parsed.objects[0].method_name, first.protocol.guarded.name);
  assert.equal(parsed.objects[0].input_extraCondition, '');
  assert.equal(parsed.objects[2].input_extraCondition, 'a,b');
  assert.equal(parsed.objects[3].summary_extraMetric, '.123456789012345'.replace(/^\./, '0.'));
  assert.ok(parsed.values.every(row => row.length === parsed.header.length));
  assert.equal(new Set(parsed.header).size, parsed.header.length);
});

test('empty input returns a usable header without fabricating method results', () => {
  const parsed = readCsv(sweepCsv([]));
  assert.equal(parsed.objects.length, 0);
  for (const key of ['method', 'input_seed', 'input_snapshots', 'summary_precision', 'summary_rejected']) assert.ok(parsed.header.includes(key));
});

test('legacy summary rows retain their historical identity and absent protocol remains blank', () => {
  const parsed = readCsv(sweepCsv([{ input: { seed: 3 }, summary: { recall: .8 } }]));
  assert.equal(parsed.objects.length, 1); assert.equal(parsed.objects[0].method, 'historical');
  assert.equal(parsed.objects[0].selection_threshold, ''); assert.equal(parsed.objects[0].summary_recall, '0.8');
});
