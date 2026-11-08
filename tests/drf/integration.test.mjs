import { METHOD_PROTOCOL, MethodComparison } from '../../drf/comparison.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateScenario } from '../../drf/scenario.mjs';
import { makeWire } from '../../drf/wire.mjs';
import { createGrid, createField } from '../../drf/field.mjs';
import { outerPeak, createEvaluator, snapshotCsv } from '../../drf/evaluate.mjs';
import { runExperiment, aggregateRuns } from '../../drf/sweep.mjs';
import { PSPT } from '../../drf/pspt.mjs';
import { createPSPTEvaluator, psptSnapshotCsv } from '../../drf/pspt-evaluate.mjs';

const input = { scene: 'reference', snapshots: 3, grid: 100, seed: 42, roughness: 2, sigmaD: .1 };
let cachedScenario;
const scenario = () => cachedScenario ??= generateScenario(input);
const sorted = values => values.slice().sort((a, b) => a - b);
function calculate(scene, prefix = scene.wire.length, pspt = false) {
  const grid = createGrid(scene.input.grid, scene.input.grid, scene.domain),
    field = createField(grid, { band: scene.input.band, perimeter: scene.input.perimeter }),
    evaluator = pspt ? createPSPTEvaluator(scene, grid) : createEvaluator(scene, grid),
    estimator = pspt ? new PSPT() : null, frames = [], evaluations = [];
  for (const wire of scene.wire.slice(0, prefix)) {
    const frame = field.step(wire);
    if (estimator) { frame.candidates = estimator.step(wire); frame.method = 'guarded45'; }
    frames.push(frame); evaluations.push(evaluator.step(frame));
  }
  return { grid, field, frames, evaluations };
}
function summary(frame, evaluation) {
  const d = evaluation.diagnostics;
  return { medianError: evaluation.medianError, p95: evaluation.p95, offwall: evaluation.offwall,
    offset: evaluation.offset, f1: evaluation.f1, caMsd: evaluation.caMsd, caHd95: evaluation.caHd95,
    observedFraction: evaluation.observedFraction, missing: evaluation.missing,
    diffusePerConfig: d.diffusePerConfig, duplicateFraction: d.duplicateFraction,
    theoremMean: d.theoremMean, theoremMedian: d.theoremMedian, theoremN: d.ratios.length,
    theoremNegative: d.theoremNegative, Q: frame.Q, admitted: frame.admitted, rejected: frame.rejected };
}

test('actual paired scenes preserve pose and standard specular noise across sigmaD/roughness changes', async () => {
  const baseline = await scenario(), changedNoise = await generateScenario({ ...input, sigmaD: .3 }),
    changedRoughness = await generateScenario({ ...input, roughness: 5 });
  for (const changed of [changedNoise, changedRoughness]) for (let t = 0; t < input.snapshots; t++) {
    assert.deepEqual(changed.truth[t].poseNoise, baseline.truth[t].poseNoise);
    assert.deepEqual(changed.truth[t].p, baseline.truth[t].p);
    for (let c = 0; c < baseline.truth[t].configs.length; c++) {
      assert.deepEqual(changed.truth[t].configs[c].specular, baseline.truth[t].configs[c].specular);
      assert.deepEqual(changed.wire[t].configs[c].pHat_i, baseline.wire[t].configs[c].pHat_i);
      assert.deepEqual(changed.wire[t].configs[c].pHat_j, baseline.wire[t].configs[c].pHat_j);
    }
  }
  for (const scene of [baseline, changedNoise, changedRoughness]) for (let t = 0; t < scene.truth.length; t++) {
    for (let c = 0; c < scene.truth[t].configs.length; c++) {
      const truth = scene.truth[t].configs[c], measured = scene.wire[t].configs[c];
      assert.ok(measured.paths.every(path => path.sigmaD === scene.input.sigmaD));
      const expected = [...truth.specular, ...truth.diffuse].map(point => point.rho + scene.input.sigmaD * point.z);
      assert.deepEqual(sorted(measured.paths.map(path => path.dHat)), sorted(expected));
    }
  }
});

test('zero roughness produces no diffuse path and no diffuse intensity in actual scenes', async () => {
  const scene = await generateScenario({ ...input, roughness: 0 });
  for (let t = 0; t < scene.truth.length; t++) for (let c = 0; c < scene.truth[t].configs.length; c++) {
    const truth = scene.truth[t].configs[c];
    assert.deepEqual(truth.diffuse, []); assert.deepEqual(truth.lambdaTotal, [0, 0]);
    assert.equal(scene.wire[t].configs[c].paths.length, truth.specular.length);
  }
});

test('actual wire contains measured fields only and oracle getters cannot alter the field', async () => {
  const scene = await scenario(), wire = structuredClone(scene.wire[0]);
  const keys = object => Object.keys(object).sort();
  assert.deepEqual(keys(wire), ['configs', 't']);
  for (const c of wire.configs) {
    assert.deepEqual(keys(c), ['Sigma_i', 'Sigma_j', 'i', 'j', 'pHat_i', 'pHat_j', 'paths']);
    for (const path of c.paths) assert.deepEqual(keys(path), ['dHat', 'sigmaD']);
  }
  const clean = makeWire(wire), poison = (object, names) => names.forEach(name => Object.defineProperty(object, name, {
    enumerable: true, get() { throw new Error(`forbidden ${name}`); },
  }));
  poison(wire, ['truth', 'walls', 'seed', 'evaluation', 'future']);
  for (const c of wire.configs) {
    poison(c, ['pTrue_i', 'pTrue_j', 'specular', 'diffuse', 'lambdaTotal', 'roughness']);
    for (const path of c.paths) poison(path, ['kind', 's', 'span', 'z', 'w', 'N', 'delta', 'dkap']);
  }
  assert.deepEqual(makeWire(wire), clean);
  const grid = createGrid(100, 100), baseline = createField(grid), poisoned = createField(grid);
  const a = baseline.step(clean), b = poisoned.step(wire);
  assert.deepEqual(a.Dbar, b.Dbar); assert.deepEqual(a.betaHat, b.betaHat);
  assert.deepEqual(baseline.D, poisoned.D); assert.deepEqual(baseline.A, poisoned.A);
});

test('real scene field prefixes remain bit-identical when future wire and all truth are poisoned', async () => {
  const scene = await scenario(), changed = { input: scene.input, wire: structuredClone(scene.wire) },
    grid = createGrid(100, 100), clean = createField(grid), polluted = createField(grid);
  Object.defineProperty(changed, 'truth', { get() { throw new Error('truth read'); } });
  Object.defineProperty(changed, 'walls', { get() { throw new Error('wall read'); } });
  changed.wire[2].configs[0].pHat_i[0] = NaN;
  Object.defineProperty(changed.wire[2].configs[0].paths[0], 'dHat', { get() { throw new Error('future measurement read'); } });
  for (let t = 0; t < 2; t++) {
    const a = clean.step(scene.wire[t]), b = polluted.step(changed.wire[t]);
    assert.deepEqual(a.Dbar, b.Dbar); assert.deepEqual(a.betaHat, b.betaHat);
    assert.deepEqual(clean.D, polluted.D); assert.deepEqual(clean.A, polluted.A);
    assert.equal(a.epsilonA, b.epsilonA); assert.equal(a.Q, b.Q);
  }
});

function flatEvaluationScene() {
  return {
    input: { roughness: 0, lambda0: 10, sigmaD: .1, sigmaP: .1 },
    walls: [[[0, 8], [60, 8]], [[0, 22], [60, 22]]],
    truth: [{ t: 1, configs: [{ i: 1, j: 2,
      specular: [{ s: [30, 8], span: 1, wall: 0, rho: 20, cth: 1, dkap: .1 }], diffuse: [] }] }],
  };
}

test('GT window affects diagnostic offset only; Outer-Peak keeps the farther strong peak', () => {
  const grid = createGrid(1, 30, [29.8, 30.2, 0, 30]), Dbar = new Float32Array(30);
  Dbar[4] = 10; Dbar[8] = 7; Dbar[22] = 7; Dbar[25] = 10;
  const extraction = outerPeak(Dbar, grid);
  assert.deepEqual(extraction.proxy, [[30, 4.5], [30, 25.5]]);
  const evaluation = createEvaluator(flatEvaluationScene(), grid).step({ t: 1, Dbar });
  assert.deepEqual(evaluation.proxy, extraction.proxy);
  assert.equal(evaluation.offset, .5, 'diagnostic must use the y=8.5 peak inside the GT window');
  assert.equal(evaluation.medianError, 3.5, 'extraction cannot select the favorable GT-near peak');
  assert.equal(evaluation.p95, 3.5); assert.equal(evaluation.offwall, 1);
});

test('missing observed outputs count as failures rather than dropping error rows', () => {
  const grid = createGrid(1, 30, [29.8, 30.2, 0, 30]),
    evaluation = createEvaluator(flatEvaluationScene(), grid).step({ t: 1, Dbar: new Float32Array(30) });
  assert.equal(evaluation.observedColumns, 1); assert.equal(evaluation.missing, 1);
  assert.equal(evaluation.medianError, Infinity); assert.equal(evaluation.p95, Infinity);
  assert.equal(evaluation.offwall, 1); assert.equal(evaluation.f1, 0);
  const unobserved = flatEvaluationScene(); unobserved.truth[0].configs[0].specular = [];
  const absent = createEvaluator(unobserved, grid).step({ t: 1, Dbar: new Float32Array(30) });
  assert.equal(absent.observedColumns, 0); assert.equal(absent.missing, 0); assert.equal(absent.medianError, null);
});

test('sweep aggregation retains failed seeds separately from genuinely unobserved values', () => {
  const run = value => ({ input: { roughness: 2, sigmaD: .1 }, summary: { medianError: value, p95: value } });
  const [failed] = aggregateRuns([run(.1), run(.3), run(Infinity), run(null)]);
  assert.equal(failed.n, 4);
  assert.deepEqual(failed.medianError, { mean: Infinity, sd: null, n: 2, failed: 1, missing: 1 });
  assert.equal(failed.p95.mean, Infinity, 'the failed seed cannot vanish into the favorable 0.2 m average');
  const [finite] = aggregateRuns([run(.1), run(.3), run(null)]);
  assert.equal(finite.medianError.mean, .2);
  assert.ok(Math.abs(finite.medianError.sd - Math.sqrt(.02)) < 1e-15);
  assert.equal(finite.medianError.n, 2); assert.equal(finite.medianError.failed, 0); assert.equal(finite.medianError.missing, 1);
  assert.deepEqual(aggregateRuns([run(null), run(undefined)])[0].medianError,
    { mean: null, sd: null, n: 0, failed: 0, missing: 2 });
  assert.equal(aggregateRuns([run(.1), run(-Infinity)])[0].medianError.mean, -Infinity);
  assert.ok(Number.isNaN(aggregateRuns([run(Infinity), run(-Infinity)])[0].medianError.mean));
  assert.ok(Number.isNaN(aggregateRuns([run(.1), run(NaN)])[0].medianError.mean));
});

test('paired sweep matches both main-view estimators on the same wire and requested duration', async () => {
  const scene=await scenario(), grid=createGrid(scene.input.grid,scene.input.grid,scene.domain), field=createField(grid),
    comparison=new MethodComparison({sigmaR:scene.input.sigmaD}),
    evaluators={guarded:createPSPTEvaluator(scene,grid),baseline:createPSPTEvaluator(scene,grid)}, progress=[];
  let last,expected;
  for (const wire of scene.wire) {
    last=field.step(wire);const methods=comparison.step(wire);
    const guarded=evaluators.guarded.step({...last,candidates:methods.guarded.candidates},null,methods.guarded.bridges);
    expected={guarded,baseline:evaluators.baseline.step({...last,candidates:methods.baseline.candidates},guarded,methods.baseline.bridges)};
  }
  const run=await runExperiment(input,t=>progress.push(t));
  assert.deepEqual(progress,[1,2,3]);assert.deepEqual(run.input,scene.input);
  assert.deepEqual(run.protocol,METHOD_PROTOCOL);assert.equal(run.method,'paired-comparison');
  for (const method of ['guarded','baseline']) {
    const e = expected[method], linear = e.interpolation, cubic = linear.hermite;
    const metrics = {...e, Q:last.Q, admitted:last.admitted, rejected:last.rejected,
      mapRecall:linear.recall, interpolatedLengthM:linear.lengthM, interpolatedOffWallM:linear.offWallM,
      hermiteMapRecall:cubic.recall, hermiteLengthM:cubic.lengthM, hermiteOffWallM:cubic.offWallM};
    for (const [key,value] of Object.entries(run.methods[method].summary))
      assert.deepEqual(value, metrics[key], `${method}/${key}`);
  }
  assert.deepEqual(run.final.Dbar,last.Dbar);assert.deepEqual(run.final.betaHat,last.betaHat);
  assert.equal(run.final.t,input.snapshots);assert.deepEqual(run.diagnostics,expected.guarded.diagnostics);
});

test('sweep aggregates never pool methods, thresholds, or different durations',()=>{
  const run=(seed,snapshots=120,threshold=6.65)=>({input:{seed,snapshots,sigmaD:.1,roughness:2},
    protocol:{guarded:{threshold},baseline:{threshold:29}},methods:{guarded:{summary:{recall:.5}},baseline:{summary:{recall:.1}}}});
  const rows=aggregateRuns([run(1),run(2),run(3,60),run(4,120,7)]);
  assert.equal(rows.length,5);
  assert.equal(rows.find(r=>r.method==='guarded'&&r.protocol.threshold===6.65&&r.input.snapshots===120).n,2);
  assert.equal(rows.find(r=>r.method==='baseline'&&r.input.snapshots===120).n,3);
});

test('snapshot CSV retains completed rows and leaves nonfinite/missing values empty', async () => {
  const manual = calculate(await scenario()), csv = snapshotCsv(manual.frames, manual.evaluations),
    rows = csv.trim().split('\r\n');
  assert.equal(rows.length, input.snapshots + 1);
  assert.ok(rows.every(row => row.split(',').length === 12));
  assert.ok(!/\b(?:NaN|Infinity|null)\b/.test(csv));
  const pathological = snapshotCsv([{ t: 1, Q: 0, admitted: 0, rejected: 0, ms: .2 }],
    [{ medianError: Infinity, p95: NaN, offwall: null, offset: -Infinity }]);
  assert.equal(pathological.trim().split('\r\n')[1], '1,0,0,0,,,,,,,,0.2');
});

test('actual JSON export handler separates truth, wire, and completed results without future snapshots', async () => {
  const scene = await generateScenario({ ...input, scene: 'layered' }), manual = calculate(scene, 2, true), source = fs.readFileSync(new URL('../../drf/app.mjs', import.meta.url), 'utf8'),
    start = source.indexOf('const jsonValue ='), end = source.indexOf("$('exportSourceSelect').onchange", start);
  assert.ok(start >= 0 && end > start, 'JSON handler bounds must be present');
  const button = {}, downloads = [], state = { scenario: scene, grid: manual.grid, frames: manual.frames,
    evaluations: manual.evaluations, sweepRuns: [], protocol: METHOD_PROTOCOL }, provenance = { baseCommit: 'integration fixture' };
  // Execute the shipped pure export handler with a download stub; no browser DOM is required.
  new Function('state', 'provenance', 'aggregateRuns', 'download', 'Blob', '$', 'METHOD_PROTOCOL', source.slice(start, end))(
    state, provenance, aggregateRuns, (blob, name) => downloads.push({ blob, name }), Blob, () => button, METHOD_PROTOCOL);
  button.onclick();
  assert.equal(downloads[0].name, 'echomap-drf.json');
  const output = JSON.parse(await downloads[0].blob.text());
  assert.equal(output.units.roughnessInput, 'deg'); assert.equal(output.units.truthAngles, 'rad'); assert.equal(output.units.betaHat, 'dimensionless');
  assert.deepEqual(output.grid.x, Array.from(manual.grid.x)); assert.deepEqual(output.grid.y, Array.from(manual.grid.y));
  assert.equal(output.grid.arrayOrder, 'iy*nx+ix; ascending y; cell centers');
  assert.equal(output.schema, 'echomap-drf/5'); assert.deepEqual(output.provenance, provenance);
  assert.deepEqual(output.estimators,METHOD_PROTOCOL);assert.equal(output.toleranceM,.4);
  assert.deepEqual(output.result.map(f=>f.candidates),manual.frames.map(f=>f.candidates));
  assert.ok(output.result.every(f=>f.method==='guarded45'));
  assert.deepEqual(output.truth.wallModel,scene.wallModel,'Preserve component coefficients and shifted knot origins in truth only');
  assert.deepEqual(output.truth.wallGeneration,scene.wallGeneration,'Preserve rejection attempts and the accepted validation protocol');
  assert.equal(output.truth.wallModel.kind,'independent-wall-uniform-cubic');
  assert.deepEqual(output.grid.domain,[0,80,-20,50]);
  assert.equal(output.truth.role, 'evaluation only'); assert.equal(output.measurement.length, 2);
  assert.equal(output.result.length, 2); assert.equal(output.evaluation.length, 2); assert.equal(output.truth.snapshots.length, 2);
  assert.deepEqual(output.measurement, scene.wire.slice(0, 2));
  assert.ok(Array.isArray(output.result[0].Dbar)); assert.ok(Array.isArray(output.result[0].betaHat));
  for (const wire of output.measurement) assert.deepEqual(Object.keys(wire).sort(), ['configs', 't']);
  assert.ok(!/\b(?:NaN|Infinity)\b/.test(await downloads[0].blob.text()));
});


test('actual CSV download exports distinct per-method rows and leaves missing precision blank',async()=>{
  const source=fs.readFileSync(new URL('../../drf/app.mjs',import.meta.url),'utf8');
  const handler=source.slice(source.indexOf("$('exportCsv').onclick"),source.indexOf("$('exportPng').onclick"));
  const scene=await scenario(),manual=calculate(scene,2,true),button={},downloads=[];
  const frames=manual.frames.map(f=>({...f,methods:{guarded:{candidates:f.candidates,ms:2},baseline:{candidates:[],ms:3}}}));
  const evaluations=manual.evaluations.map(e=>({methods:{guarded:e,baseline:{...e,precision:null,supportedCount:0}}}));
  new Function('state','psptSnapshotCsv','download','Blob','$','METHOD_PROTOCOL',handler)(
    {frames,evaluations,protocol:METHOD_PROTOCOL},psptSnapshotCsv,(blob,name)=>downloads.push({blob,name}),Blob,()=>button,METHOD_PROTOCOL);
  button.onclick();
  assert.equal(downloads[0].name,'echomap-method-comparison.csv');
  const rows=(await downloads[0].blob.text()).trim().split('\r\n').map(line=>line.split(','));
  assert.equal(rows.length,5);assert.equal(rows[0].length,29);assert.equal(rows[0][0],'method');assert.ok(rows[0].includes('linear_map_recall') && rows[0].includes('hermite_map_recall'));assert.equal(rows[0].at(-1),'implementation_revision');
  assert.deepEqual(rows.slice(1).map(row=>row[0]),['guarded','guarded','baseline','baseline']);
  assert.equal(rows[3][10],'','Undefined precision must not become zero');
  assert.equal(Number(rows[1][1]),METHOD_PROTOCOL.guarded.threshold);assert.equal(rows[3][2],METHOD_PROTOCOL.baseline.tuning.id);
  const timingColumn = rows[0].indexOf('estimator_ms'); assert.equal(rows[1][timingColumn],'2');assert.equal(rows[3][timingColumn],'3');assert.equal(rows[1].at(-1),METHOD_PROTOCOL.guarded.revision);
  assert.equal(snapshotCsv(manual.frames,manual.evaluations).trim().split('\r\n')[0].split(',').length,12);
});

test('PSPT sweep rejects exact zero range noise before generating a run', async () => {
  await assert.rejects(runExperiment({ sigmaD: 0, sigmaP: .1, vehicles: 20 }), /σd/);
});
