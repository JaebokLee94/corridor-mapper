import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeWire } from "../../drf/wire.mjs";
import { createGrid, createField, ellipticE, ellipsePerimeter, pathFieldPoint } from "../../drf/field.mjs";

const config = (paths = [{ dHat: 14, sigmaD: 0.1 }]) => ({
  i: 0, j: 1, pHat_i: [10, 12], pHat_j: [16, 13],
  Sigma_i: [0.01, 0, 0.01], Sigma_j: [0.01, 0, 0.01], paths,
});
const close = (actual, expected, relative = 1e-9) => assert.ok(
  Math.abs(actual - expected) <= relative * Math.max(Math.abs(expected), 1e-300),
  `actual ${actual}, expected ${expected}`,
);

test("AGM E uses parameter m and reproduces all four 1e-14 fixtures", () => {
  for (const [m, expected] of [[0, 1.570796326794897], [0.5, 1.350643881047675],
    [0.9, 1.104774732704073], [0.99, 1.015993545025224]]) close(ellipticE(m), expected, 1e-14);
  assert.equal(ellipticE(1), 1);
  assert.throws(() => ellipticE(-0.1)); assert.throws(() => ellipticE(NaN));
  close(ellipsePerimeter(14, Math.sqrt(37)), 41.8266747941777, 1e-14);
  close(ellipsePerimeter(14, 0, "ramanujan"), 14 * Math.PI, 1e-14);
  assert.throws(() => ellipsePerimeter(6, 6));
});

test("single path field reproduces rho/residual/gradient/K/alpha/u fixtures", () => {
  const rows = [
    [[13, 6.2], 13.962292757351, -0.037707242649, 1.803998099508, 0.9765813063142, 0.09934183422493, 0.09701537823903],
    [[13, 18], 12.539155827345, -1.460844172655, 1.753211619967, 3.573694286505e-16, 0.09654514500843, 3.450228331064e-17],
    [[20, 14], 14.321144652803, 0.321144652803, 1.999433988770, 0.1792635636019, 0.1101040183525, 0.01973763869676],
  ];
  for (const [point, rho, r, gNorm, K, alpha, u] of rows) {
    const out = pathFieldPoint(point, config(), config().paths[0]);
    for (const [name, expected] of Object.entries({ rho, r, gNorm, K, alpha, u })) close(out[name], expected);
  }
});

test("cell centers and y-ascending flatten index; initial readout beta is zero", () => {
  const grid = createGrid();
  assert.equal(grid.x[0], 0.2); assert.equal(grid.y[0], 0.1);
  close(grid.x.at(-1), 59.8, 1e-14); close(grid.y.at(-1), 29.9, 1e-14);
  assert.equal(grid.dx, 0.4); assert.equal(grid.dy, 0.2);
  const field = createField(createGrid(3, 2));
  assert.ok(field.D instanceof Float64Array); assert.ok(field.A instanceof Float64Array);
  const frame = field.readout();
  assert.ok(frame.Dbar instanceof Float32Array); assert.ok(frame.betaHat instanceof Float32Array);
  assert.ok(frame.betaHat.every((v) => v === 0)); assert.equal(frame.Q, 0);
  assert.equal(frame.epsilonA, 0);
  assert.deepEqual(field.inspect(0), { t: 0, D: 0, A: 0, Q: 0, Dbar: 0, betaHat: 0 });
});

test("factorized full A and D reproduce a scalar naive sum, including admission", () => {
  const grid = createGrid(19, 13), paths = [10, 14, 15.2, 21, 37, 6, -2].map((dHat) => ({ dHat, sigmaD: 0.1 })),
    c = config(paths), field = createField(grid, { band: "full" });
  const frame = field.step({ t: 1, configs: [c] });
  assert.equal(frame.Q, 5); assert.equal(frame.admitted, 5); assert.equal(frame.rejected, 2);
  for (let iy = 0; iy < grid.ny; iy++) for (let ix = 0; ix < grid.nx; ix++) {
    let naiveA = 0, naiveD = 0;
    for (const path of paths) {
      const p = pathFieldPoint([grid.x[ix], grid.y[iy]], c, path);
      naiveA += p.alpha; naiveD += p.u;
    }
    const at = iy * grid.nx + ix;
    close(field.A[at], naiveA, 1e-12);
    if (naiveD > 0) close(field.D[at], naiveD, 1e-12); else assert.equal(field.D[at], 0);
    assert.ok(field.D[at] >= 0 && field.D[at] <= field.A[at]);
    assert.ok(field.inspect(at).betaHat >= 0 && field.inspect(at).betaHat <= 1 + 1e-12);
  }
});

test("all three band settings respect full-beta minus truncated-beta bound", () => {
  const grid = createGrid(39, 23), c = config(Array.from({ length: 19 }, (_, k) => ({ dHat: 8 + 1.1 * k, sigmaD: 0.1 }))),
    snapshot = { t: 1, configs: [c] }, full = createField(grid, { band: "full" });
  full.step(snapshot);
  for (const band of [3, 4, 5]) {
    const trunc = createField(grid, { band }); trunc.step(snapshot);
    assert.deepEqual(trunc.A, full.A);
    for (let k = 0; k < grid.nx * grid.ny; k++) {
      const delta = full.inspect(k).betaHat - trunc.inspect(k).betaHat;
      assert.ok(delta >= -1e-15 && delta <= Math.exp(-0.5 * band * band) + 1e-15);
    }
  }
});

test("wire whitelist does not read oracle getters anywhere in the input", () => {
  const snapshot = { t: 1, configs: [config()] }, expected = makeWire(snapshot);
  const poison = (target, names) => names.forEach((name) => Object.defineProperty(target, name, {
    enumerable: true, get() { throw new Error(`oracle getter ${name}`); },
  }));
  poison(snapshot, ["truth", "seed", "wall", "future", "evaluation"]);
  poison(snapshot.configs[0], ["pTrue_i", "pTrue_j", "specular", "diffuse", "lambdaTotal", "sigma", "lambda0"]);
  poison(snapshot.configs[0].paths[0], ["s", "label", "w", "N", "delta", "sigma", "dkap"]);
  assert.deepEqual(makeWire(snapshot), expected);
  const f = createField(createGrid(10, 9)); f.step(snapshot);
  assert.equal(f.Q, 1);
  const scalar = pathFieldPoint([13, 6.2], snapshot.configs[0], snapshot.configs[0].paths[0]);
  assert.ok(scalar.u > 0);
});

test("causal prefixes are bit-identical despite future measurement poisoning", () => {
  const snapshots = Array.from({ length: 4 }, (_, index) => ({ t: index + 1, configs: [config()] })),
    changed = structuredClone(snapshots), a = createField(createGrid(20, 11)), b = createField(createGrid(20, 11));
  changed[2].configs[0].pHat_i[0] = NaN;
  Object.defineProperty(changed[3], "configs", { get() { throw new Error("future read"); } });
  for (let index = 0; index < 2; index++) {
    const frameA = a.step(snapshots[index]), frameB = b.step(changed[index]);
    assert.deepEqual(frameA.Dbar, frameB.Dbar); assert.deepEqual(frameA.betaHat, frameB.betaHat);
    assert.deepEqual(a.D, b.D); assert.deepEqual(a.A, b.A);
  }
  assert.throws(() => a.step(snapshots[0]), /causal/);
});

test("invalid covariance/noise is rejected without changing the accumulated frame", () => {
  const f = createField(createGrid(8, 7)); f.step({ t: 1, configs: [config()] });
  const previousD = f.D.slice(), previousA = f.A.slice();
  const zero = config([{ dHat: 14, sigmaD: 0 }]); zero.Sigma_i = zero.Sigma_j = [0, 0, 0];
  assert.throws(() => f.step({ t: 2, configs: [config(), zero] }), /variance/);
  assert.deepEqual(f.D, previousD); assert.deepEqual(f.A, previousA); assert.equal(f.t, 1);
  const unequal = config([{ dHat: 14, sigmaD: 0.1 }, { dHat: 16, sigmaD: 0.2 }]);
  assert.throws(() => f.step({ t: 2, configs: [unequal] }), /identical sigmaD/);
  const indefinite = config(); indefinite.Sigma_i = [0.01, 1, 0.01];
  assert.throws(() => makeWire({ t: 1, configs: [indefinite] }), /semidefinite/);
  assert.throws(() => f.inspect(-1), /bounds/);
});

test("focal guard, numerical Gaussian underflow, and empty snapshots stay finite", () => {
  const c = config(), atFocus = pathFieldPoint(c.pHat_i, c, c.paths[0]),
    far = pathFieldPoint([1e6, 1e6], c, c.paths[0]);
  assert.ok(Number.isFinite(atFocus.u)); assert.equal(far.K, 0); assert.equal(far.u, 0);
  const f = createField(createGrid(5, 5)); const frame = f.step({ t: 1, configs: [] });
  assert.equal(frame.Q, 0); assert.ok(frame.betaHat.every((v) => v === 0));
});

test("worker imports only field/wire and transfers readout copies without detaching float64 state", async () => {
  const workerSource = fs.readFileSync(new URL("../../drf/field.worker.mjs", import.meta.url), "utf8");
  assert.ok(!/scenario|evaluate|wall\.mjs|specular|diffuse/.test(workerSource));
  const oldMessage = globalThis.onmessage, oldPost = globalThis.postMessage, messages = [];
  globalThis.postMessage = (payload, transfer = []) => messages.push(structuredClone(payload, { transfer }));
  try {
    await import(`../../drf/field.worker.mjs?test=${Date.now()}`);
    globalThis.onmessage({ data: { type: "init", grid: { nx: 7, ny: 5 }, requestId: 1 } });
    globalThis.onmessage({ data: { type: "step", snapshot: { t: 1, configs: [config()] }, requestId: 2 } });
    globalThis.onmessage({ data: { type: "step", snapshot: { t: 2, configs: [config()] }, requestId: 3 } });
    globalThis.onmessage({ data: { type: "inspect", index: 2, requestId: 4 } });
    assert.deepEqual(messages.map((m) => m.type), ["initialized", "frame", "frame", "inspection"]);
    assert.equal(messages[2].Q, 2); assert.equal(messages[3].Q, 2);
    assert.equal(messages[1].Dbar.length, 35); assert.equal(messages[2].Dbar.length, 35);
    assert.ok(Number.isFinite(messages[3].D));
  } finally { globalThis.onmessage = oldMessage; globalThis.postMessage = oldPost; }
});

test("historical scalar prefix inspection is bit-identical and uses the original full-frame epsilon", async () => {
  const grid = createGrid(29, 17), numerical = { band: 4, perimeter: "exact" },
    snapshots = Array.from({ length: 4 }, (_, index) => ({ t: index + 1, configs: [
      config([12.5 + index * 0.1, 14, 15.2, 18, 25].map((dHat) => ({ dHat, sigmaD: 0.1 }))),
      { ...config(), i: 1, j: 2, pHat_i: [16.2 + index, 13.1], pHat_j: [22 + index, 14],
        paths: [15, 22].map((dHat) => ({ dHat, sigmaD: 0.1 })) },
    ] })), full = createField(grid, numerical), expected = [], indices = [1, 77, 218];
  for (let n = 0; n < 3; n++) {
    const frame = full.step(snapshots[n]);
    assert.equal(frame.epsilonA, 1e-12 * Math.max(...full.A));
    expected.push({ epsilonA: frame.epsilonA, points: indices.map((at) => full.inspect(at)) });
  }
  // This future frame remains outside every message's measured prefix.
  snapshots[3].configs[0].pHat_i[0] = NaN;
  const oldMessage = globalThis.onmessage, oldPost = globalThis.postMessage, messages = [];
  globalThis.postMessage = (payload, transfer = []) => messages.push(structuredClone(payload, { transfer }));
  try {
    await import(`../../drf/field.worker.mjs?prefix-test=${Date.now()}`);
    // prefixInspect works without initialization and never reads extra oracle properties.
    for (let n = 0; n < 3; n++) for (let k = 0; k < indices.length; k++) {
      const message = { type: "prefixInspect", grid, numerical, snapshots: snapshots.slice(0, n + 1),
        index: indices[k], epsilonA: expected[n].epsilonA, requestId: `${n}/${k}` };
      for (const name of ["truth", "future", "seed", "wall", "evaluation"])
        Object.defineProperty(message, name, { get() { throw new Error(`oracle ${name}`); } });
      globalThis.onmessage({ data: message });
      const actual = messages.at(-1), point = expected[n].points[k];
      assert.equal(actual.type, "inspection");
      for (const name of ["t", "D", "A", "Q", "Dbar", "betaHat"]) assert.equal(actual[name], point[name], `${name} must be bit-identical`);
    }
    globalThis.onmessage({ data: { type: "init", grid, numerical } });
    globalThis.onmessage({ data: { type: "step", snapshot: snapshots[0] } });
    globalThis.onmessage({ data: { type: "prefixInspect", grid, numerical, snapshots: snapshots.slice(0, 3),
      index: 77, epsilonA: expected[2].epsilonA } });
    globalThis.onmessage({ data: { type: "inspect", index: 77 } });
    assert.equal(messages.at(-2).t, 3); assert.equal(messages.at(-1).t, 1);
    assert.equal(messages.at(-1).D, expected[0].points[1].D);
    globalThis.onmessage({ data: { type: "prefixInspect", grid, numerical, snapshots: [], index: 77, epsilonA: -1 } });
    assert.equal(messages.at(-1).type, "error");
  } finally { globalThis.onmessage = oldMessage; globalThis.postMessage = oldPost; }
});

test('known-pose grid reuse preserves the sum of scalar pair fields as measured poses change', () => {
  for (const band of [3, 4, 5, 'full']) {
    const grid = createGrid(21, 13, [-0.5, 20.5, -0.5, 12.5]);
    const poses = [[3, 3], [7, 3], [8, 5]];
    const configs = [[0,1], [0,2], [1,2]].map(([i,j]) => ({
      i, j, pHat_i: poses[i], pHat_j: poses[j], Sigma_i: [0,0,0], Sigma_j: [0,0,0],
      paths: [1, 12, 17].map(dHat => ({dHat, sigmaD: 0.4})),
    }));
    // Repeated IDs may have different measured coordinates in the standalone field API.
    configs[2].pHat_i = [9, 4];
    const combined = createField(grid, {band});
    combined.step({t: 1, configs});
    const expectedD = new Float64Array(combined.D.length), expectedA = new Float64Array(combined.A.length);
    for (const config of configs) {
      const single = createField(grid, {band});
      single.step({t: 1, configs: [config]});
      for (let i = 0; i < single.D.length; i++) {
        expectedA[i] += single.A[i]; expectedD[i] += single.D[i];
      }
    }
    assert.deepEqual(combined.A, expectedA); assert.deepEqual(combined.D, expectedD);
  }
});
