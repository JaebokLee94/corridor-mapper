import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrid } from '../../drf/field.mjs';
import { createPSPTEvaluator, psptSnapshotCsv } from '../../drf/pspt-evaluate.mjs';

// A flat upper wall with only past x=30 echoes. No lower wall is supplied to
// evaluation; candidate generation/classification is outside this fixture.
const grid = createGrid(20, 20, [0, 60, 0, 30]);
const hit = () => ({ s: [30, 22], wall: 1, span: 7, rho: 20, cth: 1, dkap: .1 });
function scene() {
  return {
    input: { wallSide: 'upper', roughness: 0, lambda0: 10, sigmaD: .1, sigmaP: .1 },
    walls: [[], [[0, 22], [60, 22]]],
    truth: [1, 2, 3].map(t => ({ t, configs: [{ i: 1, j: 2, specular: [hit()], diffuse: [] }] })),
  };
}
const candidate = (id, center, status = 'supported', extra = {}) =>
  ({ id, center, status, ell: 1, phi: 0, sg: 1, kappa: 0, ...extra });
const frame = (t, candidates) => ({ t, candidates, Dbar: new Float32Array(grid.nx * grid.ny) });
const primaryKeys = ['method', 'proxy', 'observed', 'medianError', 'p95', 'offwall', 'precision',
  'surfacePrecision', 'recall', 'f1', 'observedFraction', 'missing', 'firstSupportPrecision',
  'firstSupportErrors', 'firstSupportCount', 'holdRate', 'supportedCount', 'pendingCount', 'rejectedCount'];
const primary = e => Object.fromEntries(primaryKeys.map(key => [key, e[key]]));

test('PSPT evaluation labels geometry only, independent of truth path classes and wall-side setting', () => {
  const a = scene(), b = structuredClone(a), f = frame(1, [candidate('1:h', [30, 22])]);
  b.input.wallSide = 'both';
  const config = b.truth[0].configs[0];
  config.diffuse = config.specular.map(q => ({ ...q, wall: 0, span: 1, kind: 'arbitrary-class' }));
  config.specular = [];
  const before = structuredClone(f), clean = createPSPTEvaluator(a, grid).step(f), changed = createPSPTEvaluator(b, grid).step(f);
  assert.deepEqual(primary(changed), primary(clean));
  assert.deepEqual(f, before, 'Post-hoc truth must not mutate candidate decisions or coordinates');
  assert.notEqual(changed.diagnostics.specularCount, clean.diagnostics.specularCount,
    'Class-specific reflection diagnostics are intentionally separate from candidate accuracy');
});

test('future truth is never read and cannot expand the current observed-wall mask', () => {
  const clean = scene(), poison = scene(), f = frame(1, [candidate('1:h', [30, 22])]);
  Object.defineProperty(poison.truth, 1, { get() { throw new Error('future truth read'); } });
  Object.defineProperty(poison.truth, 2, { get() { throw new Error('future truth read'); } });
  const expected = createPSPTEvaluator(clean, grid).step(f), actual = createPSPTEvaluator(poison, grid).step(f);
  assert.deepEqual(actual, expected);
  assert.ok(actual.observed.length > 0);
  assert.ok(actual.observed.every(([x, y]) => Math.abs(x - 30) <= 1 + 1e-12 && y === 22));
  const changedFuture = scene();
  changedFuture.truth[1].configs[0].specular[0].s = [50, 22];
  assert.deepEqual(createPSPTEvaluator(changedFuture, grid).step(f), expected);
});

test('no supported candidate means undefined precision and zero observed-wall recall', () => {
  for (const candidates of [[], [candidate('1:h', [30, 22], 'pending'), candidate('1:c', [30, 8], 'contradicted')]]) {
    const e = createPSPTEvaluator(scene(), grid).step(frame(1, candidates));
    assert.equal(e.precision, null); assert.equal(e.surfacePrecision, null);
    assert.equal(e.firstSupportPrecision, null); assert.equal(e.firstSupportCount, 0);
    assert.equal(e.recall, 0); assert.equal(e.f1, 0); assert.equal(e.offwall, null);
    assert.equal(e.missing, e.observed.length); assert.ok(e.missing > 0);
    assert.equal(e.supportedCount, 0);
    assert.equal(e.pendingCount, candidates.filter(c => c.status === 'pending').length);
    assert.equal(e.rejectedCount, candidates.filter(c => c.status === 'contradicted').length);
  }
  const unobserved = scene(); unobserved.truth[0].configs[0].specular = [];
  assert.equal(createPSPTEvaluator(unobserved, grid).step(frame(1, [])).recall, null,
    'No observed wall has an undefined recall denominator, rather than a perfect or failed score');
});

test('false opposite-wall support is scored as false instead of being hidden by the single-wall mode', () => {
  const evaluator = createPSPTEvaluator(scene(), grid),
    e = evaluator.step(frame(1, [candidate('1:h', [30, 22]), candidate('1:c', [30, 8]) ]));
  assert.equal(e.supportedCount, 2); assert.equal(e.precision, .5); assert.equal(e.offwall, .5);
  assert.equal(e.surfacePrecision, .5); assert.equal(e.p95, 14);
  assert.equal(e.recall, 1); assert.equal(e.f1, 2 / 3);
  assert.equal(e.firstSupportPrecision, .5); assert.equal(e.firstSupportErrors, 1);
  assert.deepEqual(e.proxy, [[30, 22], [30, 8]]);
});

test('first false support remains an error after geometry correction, rejection, and renewed support', () => {
  const evaluator = createPSPTEvaluator(scene(), grid);
  const first = evaluator.step(frame(1, [candidate('7:h', [30, 8]), candidate('7:c', [30, 22], 'pending')]));
  assert.equal(first.precision, 0); assert.equal(first.firstSupportErrors, 1); assert.equal(first.firstSupportCount, 1);
  const second = evaluator.step(frame(2, [candidate('7:h', [30, 22]), candidate('7:c', [30, 22])]));
  assert.equal(second.precision, 1); assert.equal(second.firstSupportPrecision, .5);
  assert.equal(second.firstSupportErrors, 1); assert.equal(second.firstSupportCount, 2);
  evaluator.step(frame(2, [candidate('7:h', [30, 22], 'contradicted')]));
  const third = evaluator.step(frame(3, [candidate('7:h', [30, 22])]));
  assert.equal(third.precision, 1); assert.equal(third.firstSupportErrors, 1);
  assert.equal(third.firstSupportCount, 2, 'Distinct h/c identities count once each; repeated support is not a new trial');
  assert.equal(third.firstSupportPrecision, .5);
});

test('surface coverage uses supported patch geometry, not just its correct center', () => {
  const e = createPSPTEvaluator(scene(), grid).step(frame(1, [candidate('1:h', [30, 22], 'supported', { ell: 2, kappa: 2 })]));
  assert.equal(e.precision, 1);
  assert.ok(e.surfacePrecision > 0 && e.surfacePrecision < .5, 'A curved patch can leave the wall despite a correct center');
  assert.ok(e.recall > 0 && e.recall < 1);
  assert.ok(e.f1 < 1);
});

test('curved wall and surfel sampling matches the frozen Python arc-length evaluator', () => {
  // Generated by importing the actual evaluate_runs.py wall_samples/coverage.
  // SHA-256: 74375a366d82be72fb2b19ec5077f8e96f758cf9fa77c88791e2b665549edde9.
  // Its two supported patches have 154 samples; the wall has 214 samples.
  const input = scene();
  input.walls = [[], [[0, 22], [10, 24.5]]]; // Deliberately coarse: cubic spans take priority.
  input.spans = [
    { wall: 1, h: 6, C: [[0, 22], [6, -2], [0, 3], [0, .2]] },
    { wall: 1, h: 4, C: [[6, 23.2], [4, 2], [0, -1], [0, .3]] },
  ];
  input.truth[0].configs[0].specular = [[3, 21.775], [7, 23.6421875]].map(s => ({ ...hit(), s }));
  const candidates = [
    candidate('1:h', [3, 21.775], 'supported', { ell: 2, kappa: .8, phi: .18937004997584464 }),
    candidate('1:c', [7, 18], 'supported', { ell: 1.1, phi: .7, sg: -1 }),
    candidate('2:h', [7, 23.6421875], 'pending'),
  ], e = createPSPTEvaluator(input, grid).step(frame(1, candidates));
  assert.equal(e.precision, .5); assert.equal(e.observed.length, 81);
  assert.equal(e.observedFraction, 81 / 214);
  assert.equal(e.surfacePrecision, 52 / 154); assert.equal(e.recall, 41 / 81);
  assert.ok(Math.abs(e.f1 - .40509215276458294) < 1e-14);
  const expected = [[2.0066359012015935, 21.67416296393144], [2.996617684082358, 21.774364020926697], [7.92643792678267, 23.964778547322744]];
  for (const [k, actual] of [e.observed[0], e.observed[20], e.observed.at(-1)].entries())
    for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(actual[axis] - expected[k][axis]) < 2e-12);
});

test('polyline fallback removes duplicate and near-duplicate vertices without losing endpoints', () => {
  const input = scene();
  input.walls = [[], [[0, 22], [0, 22], [1, 22], [1 + 1e-13, 22], [2, 22]]];
  input.truth[0].configs[0].specular = [{ ...hit(), s: [1, 22] }];
  const e = createPSPTEvaluator(input, grid).step(frame(1, [candidate('1:h', [1, 22])]));
  assert.equal(e.observed.length, 41); assert.equal(e.observedFraction, 1);
  assert.deepEqual(e.observed[0], [0, 22]); assert.deepEqual(e.observed.at(-1), [2, 22]);
  for (let k = 0; k < 41; k++) assert.ok(Math.abs(e.observed[k][0] - k * .05) < 1e-13);
  assert.equal(e.surfacePrecision, 1); assert.equal(e.recall, 1); assert.equal(e.f1, 1);
});

test('PSPT evaluation rejects missing candidates and noncausal snapshot order', () => {
  const evaluator = createPSPTEvaluator(scene(), grid);
  assert.throws(() => evaluator.step({ t: 1, Dbar: [] }), /candidates/);
  evaluator.step(frame(2, []));
  for (const t of [1, 4, 1.5, NaN]) assert.throws(() => evaluator.step(frame(t, [])), /causal/);
});

test('PSPT CSV exports 18 explicit columns, keeps empty precision blank, and includes first-support errors', () => {
  const evaluator = createPSPTEvaluator(scene(), grid), frames = [
    { ...frame(1, [candidate('1:h', [30, 22], 'pending')]), Q: 2, admitted: 2, rejected: 0, ms: .25, psptMs: 3 },
    { ...frame(2, [candidate('1:h', [30, 22]), candidate('1:c', [30, 8])]), Q: 5, admitted: 5, rejected: 0, ms: .5, psptMs: 4 },
  ], evaluations = frames.map(f => evaluator.step(f)), csv = psptSnapshotCsv(frames, evaluations),
    rows = csv.replace(/^\ufeff/, '').trim().split('\r\n').map(row => row.split(','));
  assert.ok(csv.startsWith('\ufeff')); assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ['snapshot', 'Q', 'admitted', 'rejected', 'supported', 'pending', 'contradicted',
    'center_precision', 'observed_wall_recall', 'first_support_precision', 'first_support_errors',
    'first_support_count', 'surface_f1', 'p95_m', 'offwall_fraction', 'hold_fraction', 'field_ms', 'pspt_ms']);
  assert.ok(rows.every(row => row.length === 18));
  assert.deepEqual(rows[1], ['1', '2', '2', '0', '0', '1', '0', '', '0', '', '0', '0', '0', '', '', '1', '0.25', '3']);
  assert.deepEqual(rows[2], ['2', '5', '5', '0', '2', '0', '0', '0.5', '1', '0.5', '1', '2', String(2/3), '14', '0.5', '0', '0.5', '4']);
  const nonfinite = psptSnapshotCsv([frames[0]], [{ precision: NaN, p95: Infinity, offwall: -Infinity }]);
  assert.ok(!/\b(?:NaN|Infinity|null|undefined)\b/.test(nonfinite));
  assert.equal(nonfinite.trim().split('\r\n')[1].split(',').length, 18);
  assert.equal(psptSnapshotCsv([], []).trim().split('\r\n').length, 1);
});


test('current evaluation does not read field peaks and is invariant to a wall crossing y=15',()=>{
  const base=scene(), moved=scene(), dx=100,dy=-20;
  moved.walls=moved.walls.map(w=>w.map(([x,y])=>[x+dx,y+dy]));
  for (const snapshot of moved.truth) for (const config of snapshot.configs)
    for (const q of config.specular) q.s=[q.s[0]+dx,q.s[1]+dy];
  const make=(x,y)=>({t:1,candidates:[candidate('one',[x,y])],get Dbar(){throw Error('legacy field accessed');}});
  const a=createPSPTEvaluator(base,grid).step(make(30,22)),b=createPSPTEvaluator(moved,grid).step(make(130,2));
  for (const key of ['precision','recall','p95','offwall','firstSupportPrecision']) assert.equal(a[key],b[key],key);
  assert.deepEqual(a.diagnostics,b.diagnostics);
  for (const key of ['offset','observedColumns','caMsd','caHd95']) assert.equal(Object.hasOwn(b,key),false,key);
});

test('map F1 counts unseen wall, penalizes spurious map length, and never fills an aperture in truth',()=>{
  const C=(x)=>[[x,22],[2,0],[0,0],[0,0]];
  const s={...scene(),spans:[{wall:0,C:C(0)},{wall:0,C:C(4)}]};
  const run=(cs,bridges=[])=>createPSPTEvaluator(s,grid).step(frame(0,cs),{diagnostics:{}},bridges).interpolation;
  const a=candidate('a',[1,22]),b=candidate('b',[5,22]),out=candidate('x',[1,10]);
  assert.equal(run([]).rawMap.mapF1,0);
  assert.equal(run([a]).recall,null);
  assert.equal(run([a]).rawMap.mapF1,2/3);
  assert.equal(run([a,b]).rawMap.mapF1,1);
  assert.ok(Math.abs(run([a,b,out]).rawMap.mapF1-.8)<1e-10);
  const points=[[2,22],[4,22]],mapped=run([a,b],[{from:'a',to:'b',points,curve:points}]);
  assert.ok(mapped.offWallM>1 && mapped.mapF1<1 && mapped.mapF1>.85);
  assert.ok(mapped.centre.mapF1<1 && mapped.hermite.mapF1===mapped.mapF1);
});
