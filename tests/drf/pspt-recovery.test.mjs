import test from 'node:test';
import assert from 'node:assert/strict';
import { PSPT, prepareMeasuredSnapshot } from '../../drf/pspt.mjs';
import { Surfel } from '../../drf/pspt-math.mjs';
import { planRecovery, commitRecovery, initializeRecovery } from '../../drf/pspt-recovery.mjs';
import { selectGuarded } from '../../drf/comparison.mjs';
import { createPSPTEvaluator } from '../../drf/pspt-evaluate.mjs';

const options = { refinement: 'shared-pose', clustering: 'bounded-span', geometryUpdate: 'curvature-consistent', recovery: 'bounded' };
const copy = value => structuredClone(value);
const fingerprint = model => JSON.stringify(model);

/** Analytic two-plane fixture, independent of any reported seed or output.
 * Three noncollinear receivers lie between y=-5 and y=5. Reflection of one
 * endpoint across y=w gives rho=sqrt((xj-xi)^2+(2w-yi-yj)^2). Values are measured
 * wire fields only; neither plane label nor true points enter the estimator.
 */
function wire(t, empty = false) {
  const positions = [[8 + .25 * t, 0], [10 + .25 * t, 1], [12 + .25 * t, .2]], configs = [];
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) configs.push({
    i: i + 1, j: j + 1, pHat_i: positions[i].slice(), pHat_j: positions[j].slice(),
    Sigma_i: [.01, 0, .01], Sigma_j: [.01, 0, .01],
    paths: empty ? [] : [-5, 5].map(w => ({ dHat: Math.hypot(positions[j][0] - positions[i][0],
      2 * w - positions[i][1] - positions[j][1]), sigmaD: .1 })),
  });
  return { t, configs };
}

// Controlled lifecycle state for component tests, not a saved algorithm output.
function group(gid, center = [13, 5], counterpart = [13, -5], fresh = false) {
  const n = fresh ? 0 : 3;
  const value = { gid, s: [new Surfel(center, 0, [0, -1]), new Surfel(counterpart, 0, [0, 1])],
    birth: fresh ? 12 : 1, src: fresh ? [1, 12] : [1, 1],
    L: fresh ? [0, 0, 0, 0] : [0, -12, 12, 0], post: fresh ? [.25, .25, .25, .25] : [0, 0, 1, 0],
    r: fresh ? [.5, .5] : [0, 1], nobs: n, first_obs: fresh ? null : 2,
    status: fresh ? ['pending', 'pending'] : ['contradicted', 'supported'], reason: ['fixture', 'fixture'],
    log: fresh ? [] : [[2, 3, [0, -12, 12, 0]]], changes: [[], []],
    active_steps: [n, n], first_active: fresh ? [null, null] : [2, 2],
    matched_steps: [0, n], first_match: fresh ? [null, null] : [null, 2], matched_configs: [0, n],
    own_core_snapshots: [n, n], own_matched_snapshots: [0, n], first_own_range_match: fresh ? [null, null] : [null, 2],
    qualified_active: [n, n], qualified_matched: [0, n] };
  initializeRecovery(value); return value;
}

function sideSnapshot(g, k) {
  return { center: g.s[k].center, x: g.s[k].x.slice(), P: copy(g.s[k].P),
    counters: ['active_steps', 'matched_steps', 'matched_configs', 'own_core_snapshots', 'own_matched_snapshots',
      'qualified_active', 'qualified_matched'].map(name => g[name][k]) };
}

test('recovery planning is read-only and distinguishes rejected geometry from a live counterpart', () => {
  const parent = group(7), groups = [parent], before = fingerprint(groups);
  const plan = planRecovery(groups, [], [13.1, 5], 1);
  assert.equal(plan.blocked, false); assert.equal(plan.parents.length, 1);
  assert.equal(plan.parents[0].g, parent); assert.equal(plan.parents[0].side, 0);
  assert.equal(planRecovery(groups, [], [13.1, -5], 1).blocked, true);
  parent.status[0] = 'pending';
  assert.equal(planRecovery(groups, [], [13.1, 5], 1).blocked, true);
  parent.status[0] = 'contradicted';
  assert.equal(fingerprint(groups), before);
});

test('replacement preserves the live counterpart and starts the child without inherited evidence', () => {
  const parent = group(7), child = group(8, [13.1, 5], [13.1, -5], true), tombstones = [];
  const live = sideSnapshot(parent, 1), oldL = parent.L.slice(), oldHistory = copy(parent.log);
  commitRecovery([parent], tombstones, child, planRecovery([parent], [], [13.1, 5], 1).parents, 12);
  assert.deepEqual(sideSnapshot(parent, 1), live); assert.equal(parent.retired[1], null);
  assert.deepEqual(parent.L, oldL); assert.deepEqual(parent.log, oldHistory);
  assert.equal(parent.retired[0].replacement, '8h');
  assert.equal(child.recoveryAttempts[0], 1); assert.deepEqual(child.replaces[0], ['7h']);
  assert.deepEqual(child.L, [0, 0, 0, 0]); assert.equal(child.nobs, 0); assert.equal(child.first_obs, null);
  assert.deepEqual(child.qualified_active, [0, 0]); assert.deepEqual(child.qualified_matched, [0, 0]);
  assert.deepEqual(child.log, []);
  assert.ok(child.retired[1]); assert.equal(child.retired[1].replacement, '7c');
  const saved = copy(parent.retired[0]); parent.s[0].x[0] += 5; parent.s[0].P[0][0] += 2;
  assert.deepEqual(parent.retired[0], saved, 'retirement audit must own its state/covariance arrays');
});

test('fixed tombstones and exhausted lineages block a third trial, including fit movement and mirrors', () => {
  const parent = group(7), child = group(8, [13.1, 5], [13.1, -5], true), tombstones = [];
  commitRecovery([parent], tombstones, child, planRecovery([parent], [], [13.1, 5], 1).parents, 12);
  child.status[0] = 'contradicted'; child.s[0].c0[0] = 20;
  assert.equal(planRecovery([parent, child], tombstones, [13, 5], 1).blocked, true,
    'child drift must not reopen the original failed neighborhood');
  assert.equal(planRecovery([parent, child], tombstones, [20, 5], 1).blocked, true,
    'the replacement itself has no second retry');
  assert.equal(planRecovery([parent, child], tombstones, [13.75, 5], .5, 1).blocked, true,
    'post-fit NMS radius must not shrink the fixed 1 m recovery exclusion');
  const rawOutsideMovedChild = [21.1, 5], fittedNearMovedChild = [20.75, 5];
  assert.equal(planRecovery([parent, child], tombstones, rawOutsideMovedChild, 1, 1).blocked, false,
    'a raw ridge outside the moved child neighborhood remains a new proposal');
  assert.equal(planRecovery([parent, child], tombstones, fittedNearMovedChild, .5, 1).blocked, true,
    'post-fit movement must not bypass a moved replacement retry budget outside the ancestor tombstone');
  const mirroredAttempt = group(9, [30, -5], [13.75, 5], true);
  commitRecovery([parent, child], tombstones, mirroredAttempt, [], 15, 1);
  assert.ok(mirroredAttempt.retired[1], 'mirror generation must not bypass the ancestor tombstone');
  const exhausted = group(10, [40, 5], [40, -5]); exhausted.recoveryAttempts[0] = 1;
  const mirrorOfExhausted = group(11, [50, -5], [40.7, 5], true);
  commitRecovery([exhausted], [], mirrorOfExhausted, [], 15, 1);
  assert.ok(mirrorOfExhausted.retired[1], 'an exhausted rejected patch cannot be cloned as a fresh mirror');
});

test('a birth fit with no matching data leaves the old group and retry budget untouched', () => {
  const model = new PSPT(options), parent = group(7), prepared = prepareMeasuredSnapshot(wire(12, true));
  model.groups = [parent]; model.hist = [[12, prepared.pre]];
  model.drf.ridges = () => [[13, 5, 0]];
  const before = fingerprint({ groups: model.groups, tombstones: model.recoveryTombstones });
  model._births(12, prepared.veh);
  assert.equal(fingerprint({ groups: model.groups, tombstones: model.recoveryTombstones }), before);
});

test('post-fit recovery finds rejected parents outside NMS without widening live-candidate NMS', () => {
  const parent = group(7, [10, 5], [10, -5]);
  const raw = [11.1, 5], fitted = [10.75, 5];
  const rawPlan = planRecovery([parent], [], raw, 1, 1);
  assert.equal(rawPlan.blocked, false); assert.deepEqual(rawPlan.parents, []);
  const fittedPlan = planRecovery([parent], [], fitted, .5, 1);
  assert.equal(fittedPlan.blocked, false); assert.equal(fittedPlan.parents.length, 1);
  assert.equal(fittedPlan.parents[0].g, parent); assert.equal(fittedPlan.parents[0].side, 0);
  const child = group(8, fitted, [10.75, -5], true), tombstones = [];
  commitRecovery([parent], tombstones, child, fittedPlan.parents, 12, 1);
  assert.equal(child.recoveryAttempts[0], 1); assert.deepEqual(child.replaces[0], ['7h']);
  assert.equal(parent.retired[0].replacement, '8h');
  assert.equal(planRecovery([parent, child], tombstones, fitted, .5, 1).blocked, true);

  for (const status of ['pending', 'supported']) {
    const live = group(9, [10, 5], [10, -5]); live.status[0] = status;
    const livePlan = planRecovery([live], [], fitted, .5, 1);
    assert.equal(livePlan.blocked, false, 'ordinary post-fit NMS remains 0.5 m');
    assert.deepEqual(livePlan.parents, [], 'a live candidate is never a replacement parent');
    assert.equal(planRecovery([live], [], [10.25, 5], .5, 1).blocked, true);
  }
});

test('a measured-only replacement is born after fitting and scores only strictly later snapshots', () => {
  const model = new PSPT(options); model._births = () => {};
  for (let t = 1; t <= 12; t++) model.step(wire(t));
  delete model._births;
  const parent = group(42); model.groups = [parent];
  model.drf.ridges = () => [[13, 5, 0]];
  model._births(12, prepareMeasuredSnapshot(wire(12)).veh);
  assert.equal(model.groups.length, 2);
  const child = model.groups[1];
  assert.equal(child.gid, 43); assert.equal(child.birth, 12); assert.deepEqual(child.src, [1, 12]);
  assert.deepEqual(child.L, [0, 0, 0, 0]); assert.equal(child.nobs, 0); assert.deepEqual(child.log, []);
  assert.deepEqual(child.qualified_active, [0, 0]); assert.deepEqual(child.qualified_matched, [0, 0]);
  assert.ok(parent.retired[0]);
  model.drf.ridges = () => [];
  model.step(wire(13));
  assert.ok(child.log.length > 0, 'the next predictive snapshot should supply new evidence');
  assert.ok(child.log.every(([t]) => t > child.birth && t > child.src[1]));
  assert.ok(child.first_obs > child.src[1]);
  assert.ok(child.qualified_active.every(n => n <= 1), 'birth-window activity must not be reused');
});

test('retired sides stop prediction, geometry and evidence counters but preserve their live counterpart', () => {
  const model = new PSPT(options), parent = group(7), child = group(8, [13.1, 5], [13.1, -5], true);
  model._births = () => {};
  for (let t = 1; t <= 12; t++) model.step(wire(t));
  commitRecovery([parent], model.recoveryTombstones, child, planRecovery([parent], [], [13.1, 5], 1).parents, 12);
  model.groups = [parent, child]; model.last_t = 12; model._births = () => {};
  const frozen = sideSnapshot(parent, 0), liveBefore = sideSnapshot(parent, 1), retirement = copy(parent.retired[0]);
  parent.s[0].predict = () => { throw Error('retired surface predicted'); };
  child.s[1].predict = () => { throw Error('duplicate mirror predicted'); };
  for (let t = 13; t <= 15; t++) model.step(wire(t));
  assert.deepEqual(sideSnapshot(parent, 0), frozen); assert.deepEqual(parent.retired[0], retirement);
  assert.ok(parent.own_core_snapshots[1] > liveBefore.counters[3], 'the existing opposite side remains live');
  const rows = selectGuarded(model);
  assert.ok(rows.some(row => row.id === '7c')); assert.ok(!rows.some(row => ['7h', '8c'].includes(row.id)));
  // Even a large coupled marginal logit must not resurrect an inactive side.
  parent.L = [0, 100, 0, 100]; model._status(parent, 15);
  assert.ok(!selectGuarded(model).some(row => row.id === '7h'));
});

test('retired geometry does not change the range cutoff or live explaining-away scores', () => {
  const model = new PSPT(options), parent = group(7, [13, 5], [100, -5]);
  parent.retired[0] = { reason: 'component fixture', t: 1 }; model.groups = [parent];
  parent.s[1].predict = () => { throw Error('far live side bypassed max-range cutoff'); };
  const prep = prepareMeasuredSnapshot(wire(2)); model.current_t = 2;
  assert.equal(model._predictAll(prep.pre, prep.veh).size, 0);

  // Isolate the competition algebra with fixed likelihoods. Only a retired
  // center moves; all active centers, measured ranges and likelihoods match.
  function competitionModel(retiredCenter) {
    const estimator = new PSPT(options), a = group(7, retiredCenter, [13, -5]), b = group(8, [13, 5], [30, 5]);
    estimator._births = () => {};
    estimator.step(wire(1));
    a.retired[0] = { reason: 'component fixture', t: 1 }; b.retired[1] = { reason: 'component fixture', t: 1 };
    b.status[0] = 'supported'; b.r = [1, .5]; b.L = [0, 12, 0, 12];
    estimator.groups = [a, b]; estimator.last_t = 1; estimator._births = () => {}; estimator._kf = () => {};
    estimator._predictAll = pre => new Map(estimator.groups.flatMap(g => [0, 1].map(k => [`${g.gid}:${k}`,
      pre.map(() => g.retired[k] ? null : { core: true, sr2: .01, G: [[0, 1]],
        p: [10, 0, [0, 0, 0], [-1, 0], [-1, 0]] })])));
    return estimator;
  }
  const near = competitionModel([13, 5]), far = competitionModel([70, 40]);
  near.step(wire(2)); far.step(wire(2));
  for (let k = 0; k < 2; k++) assert.deepEqual(near.groups[k].L, far.groups[k].L,
    'a retired center must not shield live candidates from explaining-away competition');
});

test('recovery mode remains causal and rejects truth, seed, future and accessors before mutation', () => {
  const short = new PSPT(options), full = new PSPT(options), inputs = Array.from({ length: 16 }, (_, i) => wire(i + 1));
  let prefix, fullPrefix;
  for (const input of inputs.slice(0, 12)) prefix = short.step(input);
  for (const input of inputs) { const rows = full.step(input); if (input.t === 12) fullPrefix = copy(rows); }
  assert.ok(full.groups.length > 0); assert.deepEqual(prefix, fullPrefix);
  assert.ok(full.groups.every(g => g.log.every(([t]) => t > g.birth && t > g.src[1])));
  const savedRows = copy(prefix), before = fingerprint(short);
  for (const key of ['truth', 'seed', 'walls', 'wallSide', 'future', 'field']) {
    const bad = copy(inputs[12]); let read = false;
    Object.defineProperty(bad, key, { enumerable: true, get() { read = true; throw Error('forbidden getter'); } });
    assert.throws(() => short.step(bad), /non-wire/); assert.equal(read, false); assert.equal(fingerprint(short), before);
    assert.throws(() => new PSPT({ ...options, [key]: 1 }), /non-wire/);
  }
  const nested = copy(inputs[12]); nested.configs[0].paths[0].isSpecular = true;
  assert.throws(() => short.step(nested), /non-wire/); assert.equal(fingerprint(short), before);
  const alternateFuture = copy(inputs[12]); for (const c of alternateFuture.configs) for (const p of c.paths) p.dHat += 2;
  short.step(alternateFuture); assert.deepEqual(prefix, savedRows, 'later measurements must not mutate earlier reports');
});

test('retiring a previously wrong first support does not erase that error from post-hoc evaluation', () => {
  const scenario = { input: { roughness: 0, sigmaD: .1, sigmaP: .1, lambda0: 10 },
    walls: [[[0, 0], [20, 0]]], truth: [{ configs: [] }, { configs: [] }] };
  const evaluator = createPSPTEvaluator(scenario, null);
  const falsePatch = { id: '7h', center: [10, 5], ell: 1, phi: 0, kappa: 0, sg: -1, status: 'supported' };
  const first = evaluator.step({ t: 1, candidates: [falsePatch] }, { diagnostics: {} });
  const afterRetirement = evaluator.step({ t: 2, candidates: [] }, { diagnostics: {} });
  assert.equal(first.firstSupportErrors, 1); assert.equal(afterRetirement.firstSupportErrors, 1);
  assert.equal(afterRetirement.firstSupportCount, 1); assert.equal(afterRetirement.precision, null);
});
