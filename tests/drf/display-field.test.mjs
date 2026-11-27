import test from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayField } from '../../drf/display-field.mjs';
import { createGrid, createField, pathFieldPoint } from '../../drf/field.mjs';

const config = (a, b, dHat, sigmaD = 0.4) => ({
  i: 0, j: 1, pHat_i: a, pHat_j: b, Sigma_i: [0, 0, 0], Sigma_j: [0, 0, 0],
  paths: [{dHat, sigmaD}],
});

function indexAt(grid, x, y) {
  const ix = grid.x.indexOf(x), iy = grid.y.indexOf(y);
  assert.ok(ix >= 0 && iy >= 0, 'point lies on the expanded lattice');
  return iy * grid.nx + ix;
}

test('ellipse tips on both sides of the wall interval retain their measured density and contrast', () => {
  const base = createGrid(10, 10, [-0.5, 9.5, -0.5, 9.5]);
  const c = config([2, 2], [6, 2], 24), wire = {t: 1, configs: [c]};
  const frame = createDisplayField(base).step(wire), central = createField(base).step(wire);
  assert.equal(frame.grid.dx, base.dx); assert.equal(frame.grid.dy, base.dy);
  assert.equal(frame.Q, 1);
  for (const x of [-8, 16]) {
    const i = indexAt(frame.grid, x, 2), analytic = pathFieldPoint([x, 2], c, c.paths[0]);
    assert.equal(analytic.r, 0);
    assert.equal(frame.Dbar[i], Math.fround(analytic.u));
    assert.equal(frame.betaHat[i], Math.fround(analytic.u / (analytic.alpha + frame.epsilonA)));
  }
  for (const y of base.y) for (const x of base.x) {
    assert.equal(frame.Dbar[indexAt(frame.grid, x, y)], central.Dbar[indexAt(base, x, y)]);
    assert.ok(Math.abs(frame.betaHat[indexAt(frame.grid, x, y)] - central.betaHat[indexAt(base, x, y)]) < 1e-7);
  }
});

test('a rotated noisy ellipse has no missing support against an independently padded grid', () => {
  const base = createGrid(9, 7, [-0.5, 8.5, -0.5, 6.5]), c = config([2, 0], [8, 8], 23, 0.75);
  c.Sigma_i = [3.5, 1.3, 0.9]; c.Sigma_j = [0.7, -0.6, 2.1];
  const wire = {t: 1, configs: [c]}, numerical = {band: 5};
  const frame = createDisplayField(base, numerical).step(wire);
  const referenceGrid = createGrid(91, 81, [-40.5, 50.5, -34.5, 46.5]);
  const reference = createField(referenceGrid, numerical).step(wire);
  for (let iy = 0; iy < referenceGrid.ny; iy++) for (let ix = 0; ix < referenceGrid.nx; ix++) {
    const expected = reference.Dbar[iy * referenceGrid.nx + ix];
    if (expected > 0) assert.equal(frame.Dbar[indexAt(frame.grid, referenceGrid.x[ix], referenceGrid.y[iy])], expected);
  }
});

test('successive extensions preserve the complete past denominator and immutable earlier frames', () => {
  const base = createGrid(15, 11, [-0.6, 9.4, -3.8, 6.2]);
  const display = createDisplayField(base);
  const wires = [
    {t: 1, configs: [config([2, 3], [4, 3], 6)]},
    {t: 2, configs: [config([25, 1], [27, 1], 22)]},
    {t: 3, configs: [config([-35, -3], [-30, -4], 13)]},
  ];
  const first = display.step(structuredClone(wires[0])), saved = structuredClone(first);
  const input = structuredClone(wires[1]), second = display.step(input);
  input.configs[0].pHat_i[0] = -500; // The caller no longer owns history used for replay.
  assert.throws(() => display.step({t: 4, configs: []}), /causal/);
  const last = display.step(wires[2]), reference = createField(last.grid);
  assert.ok(second.grid.xmax > first.grid.xmax && last.grid.xmin < second.grid.xmin);
  let exact;
  for (const wire of wires) exact = reference.step(wire);
  assert.deepEqual(last.Dbar, exact.Dbar); assert.deepEqual(last.betaHat, exact.betaHat);
  assert.equal(last.Q, 3); assert.equal(last.epsilonA, exact.epsilonA);
  assert.deepEqual(first, saved);
  for (const x of base.x) assert.ok(last.grid.x.includes(x));
  for (const y of base.y) assert.ok(last.grid.y.includes(y));
});

test('full Gaussian and empty or inadmissible snapshots retain their numerical meaning', () => {
  const base = createGrid(6, 6, [-0.5, 5.5, -0.5, 5.5]), numerical = {band: 'full'};
  const display = createDisplayField(base, numerical);
  const empty = display.step({t: 1, configs: []});
  const rejected = display.step({t: 2, configs: [config([90, 9], [100, 9], 7)]});
  assert.equal(empty.grid, base); assert.equal(rejected.grid, base);
  assert.equal(rejected.Q, 0); assert.equal(rejected.rejected, 1); assert.ok(rejected.Dbar.every(v => v === 0));
  const c = config([0, 0], [2, 0], 6, 1);
  const full = display.step({t: 3, configs: [c]});
  const tail = indexAt(full.grid, 9, 0), analytic = pathFieldPoint([9, 0], c, c.paths[0]);
  assert.equal(analytic.r, 10); assert.ok(full.Dbar[tail] > 0);
  assert.equal(full.Dbar[tail], Math.fround(analytic.u));
  assert.equal(full.rejected, 1); assert.equal(full.admitted, 1);
  assert.ok(full.grid.xmax < 16, 'ordinary paths need no grid for numerically invisible tails');
});

test('full mode preserves Float32 density tails above 16 SD for narrow high-density paths', () => {
  const spacing = 1e-9, base = createGrid(2, 2, [-0.5 * spacing, 1.5 * spacing, -0.5 * spacing, 1.5 * spacing]);
  const c = config([0, 0], [0, 0], 20 * spacing, spacing);
  const full = createDisplayField(base, {band: 'full'}).step({t: 1, configs: [c]});
  // Coincident foci form a circle. At radius >=1 nm, |grad rho|=2,
  // so the independent density is 2 exp(-z²/2)/(sqrt(2π)*sigma*π*dHat).
  const alpha = 2 / (Math.sqrt(2 * Math.PI) * spacing * Math.PI * c.paths[0].dHat);
  let beyond16 = 0;
  for (let y = -26; y <= 26; y++) for (let x = -26; x <= 26; x++) {
    const radius = Math.hypot(x, y) * spacing;
    if (radius < spacing) continue;
    const z = (2 * radius - c.paths[0].dHat) / spacing, kernel = Math.exp(-0.5 * z * z);
    const density = Math.fround(alpha * kernel), contrast = Math.fround(alpha * kernel / (alpha + full.epsilonA));
    if (!density && !contrast) continue;
    if (z > 16 && density > 0) beyond16++;
    const ix = Math.round((x * spacing - full.grid.x[0]) / spacing);
    const iy = Math.round((y * spacing - full.grid.y[0]) / spacing);
    assert.ok(ix >= 0 && ix < full.grid.nx && iy >= 0 && iy < full.grid.ny);
    assert.equal(full.Dbar[iy * full.grid.nx + ix], density);
    assert.equal(full.betaHat[iy * full.grid.nx + ix], contrast);
  }
  assert.ok(beyond16 > 0);
});

test('new margins and a retried snapshot match a single full-grid accumulator', () => {
  const base = createGrid(10, 10, [-0.5, 9.5, -0.5, 9.5]);
  const display = createDisplayField(base);
  const wires = [
    {t:1,configs:[config([2,2],[6,2],4.5)]},
    {t:2,configs:[config([15,12],[17,16],20)]},
    {t:3,configs:[config([-1,-3],[-4,-5],24),config([15,1],[15,2],8)]},
  ];
  display.step(wires[0]);
  const previous = display.step(wires[1]), saved = structuredClone(previous);
  // Only cells at x=15 have zero variance. The original tile can complete before a margin rejects the input.
  const invalid = config([15,1],[15,2],8,0);
  invalid.Sigma_i = [1,0,0]; invalid.Sigma_j = [1,0,0];
  assert.throws(() => display.step({t:3,configs:[invalid]}), /variance/);
  const final = display.step(wires[2]), reference = createField(final.grid);
  let expected;
  for (const wire of wires) expected = reference.step(wire);
  assert.deepEqual(previous, saved);
  for (const key of ['Q','admitted','rejected','epsilonA','Dbar','betaHat']) assert.deepEqual(final[key],expected[key],key);
});

test('crossing the next two-cell block adds only that block and keeps both ellipse tips', () => {
  const base = createGrid(16, 16, [-0.5, 15.5, -0.5, 15.5]), display = createDisplayField(base);
  const earlier = config([18, 8], [22, 8], 6, 0.1), later = config([19, 8], [23, 8], 6, 0.1);
  const first = display.step({t: 1, configs: [earlier]}), saved = structuredClone(first);
  const second = display.step({t: 2, configs: [later]});
  // The 4-SD outer right tips are 23.2 m and 24.2 m; each margin block is 2 m.
  assert.deepEqual(first.grid.domain, [-0.5, 23.5, -0.5, 15.5]);
  assert.deepEqual(second.grid.domain, [-0.5, 25.5, -0.5, 15.5]);
  assert.equal(second.Q, 2);
  for (const [x, pair] of [[23, earlier], [24, later]]) {
    const peak = pathFieldPoint([x, 8], pair, pair.paths[0]);
    assert.equal(peak.r, 0);
    assert.equal(second.Dbar[indexAt(second.grid, x, 8)], Math.fround(peak.u / 2));
  }
  assert.deepEqual(first, saved);
});

test('the first expanded grid spanning multiple 64K row tiles matches a single full-grid field', () => {
  const base = createGrid(200, 200, [-0.5, 199.5, -0.5, 199.5]);
  const poses = Array.from({length: 10}, (_, i) => [94 + i, 96 + i % 5]);
  const configs = [];
  for (let i = 0; i < poses.length; i++) for (let j = i + 1; j < poses.length; j++) {
    configs.push({...config(poses[i], poses[j], 260 + (i + j) % 4), i, j});
  }
  const wire = {t: 1, configs}, frame = createDisplayField(base).step(wire);
  const {nx, ny} = frame.grid, boundaryRow = Math.floor(64 * 1024 / nx);
  assert.ok(nx * ny > 64 * 1024 && boundaryRow > 0 && boundaryRow < ny);
  const reference = createField(frame.grid).step(wire);
  for (const row of [boundaryRow - 1, boundaryRow]) {
    const expectedRow = reference.Dbar.subarray(row * nx, (row + 1) * nx);
    assert.ok(expectedRow.some(value => value > 0), 'each side of the tile boundary has measured support');
    assert.deepEqual(frame.Dbar.subarray(row * nx, (row + 1) * nx), expectedRow);
  }
  assert.equal(frame.Q, 45);
  for (const key of ['Q', 'epsilonA', 'Dbar', 'betaHat']) assert.deepEqual(frame[key], reference[key], key);
});
