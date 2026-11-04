import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInput, createSceneGeometry, truePoses, generateTruthSnapshot, measureTruthSnapshot,
  generateSnapshot, generateScenario } from '../../drf/scenario.mjs';
import { specularPoints } from '../../drf/specular.mjs';
import { diffuseProfile, sampleDiffuse } from '../../drf/diffuse.mjs';
import { createRng } from '../../drf/rng.mjs';
import { makeWire } from '../../drf/wire.mjs';

// Frozen pre-refactor producer from 7c1b5c07a3cd81728a8b443720a7522bd01d2f94.
// This checks bit-preserving decomposition, not independent physical correctness;
// analytic geometry and Poisson-model checks remain in the other DRF tests.
function originalGenerateSnapshot(input, spans, t, wallModel = null) {
  if (input.scene === 'layered' && !wallModel) throw new Error('Layered snapshots require their accepted truth wall model');
  const p = truePoses(t, input.vehicles, wallModel), sigma2 = input.sigmaP ** 2,
    activeWalls = [...new Set(spans.map(span => span.wall))];
  const poseNoise = p.map((_, v) => {
    // Stream addresses use the same 1-based vehicle IDs as the wire.
    const r = createRng(input.seed, 'pose', t, v + 1);
    return [r.normal(), r.normal()];
  });
  const pHat = p.map((q, v) => q.map((a, k) => a + input.sigmaP * poseNoise[v][k]));
  const truth = { t, p, poseNoise, configs: [] }, measured = { t, configs: [] };
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
    const spec = input.specular ? specularPoints(spans, p[i], p[j]) : [];
    const specRng = createRng(input.seed, 'specNoise', t, i + 1, j + 1);
    const diffRng = createRng(input.seed, 'diffNoise', t, i + 1, j + 1);
    const profile = diffuseProfile(spans, p[i], p[j], input.roughness * Math.PI / 180, input.lambda0, input.cellStep);
    // Keep logical lower/upper indices even if one physical wall is absent.
    const diffuse = [], diffuseSampling = { beforeThinning: [0, 0], afterThinning: [0, 0] };
    for (const wall of activeWalls) {
      const cells = profile.cells.filter(c => c.wall === wall);
      const wallProfile = { cells, lambdaTotal: profile.lambdaTotal };
      const diagnostics = {}, points = sampleDiffuse(spans, p[i], p[j], wallProfile, createRng(input.seed, 'diffuse', t, i + 1, j + 1, wall), diagnostics);
      diffuseSampling.beforeThinning[wall] = diagnostics.generated;
      diffuseSampling.afterThinning[wall] = points.length;
      diffuse.push(...points);
    }
    const tagged = [
      ...spec.map(point => ({ ...point, kind: 'specular', z: specRng.normal() })),
      ...diffuse.map(point => ({ ...point, kind: 'diffuse', z: diffRng.normal() })),
    ];
    let emitted = tagged;
    if (input.resolution > 0) {
      emitted = []; let previous = -Infinity;
      for (const point of tagged.slice().sort((a, b) => a.rho - b.rho))
        if (point.rho - previous >= input.resolution) { emitted.push(point); previous = point.rho; }
    }
    const paths = emitted.map(point => ({ dHat: point.rho + input.sigmaD * point.z, sigmaD: input.sigmaD }));
    const shuffle = createRng(input.seed, 'shuffle', t, i + 1, j + 1);
    for (let k = paths.length - 1; k > 0; k--) {
      const n = Math.floor(shuffle.uniform() * (k + 1)); [paths[k], paths[n]] = [paths[n], paths[k]];
    }
    truth.configs.push({ i: i + 1, j: j + 1,
      specular: emitted.filter(q => q.kind === 'specular').map(({ kind, ...q }) => q),
      diffuse: emitted.filter(q => q.kind === 'diffuse').map(({ kind, ...q }) => q),
      lambdaTotal: profile.lambdaTotal,
      diffuseSampling,
      // Existing generated counts are visible paths before resolution merging.
      generated: { specular: spec.length, diffuse: diffuse.length },
      numericalDiagnostics: spec.diagnostics ?? { degenerateSpans: [], unresolved: 0 },
    });
    measured.configs.push({ i: i + 1, j: j + 1, pHat_i: pHat[i], pHat_j: pHat[j],
      Sigma_i: [sigma2, 0, sigma2], Sigma_j: [sigma2, 0, sigma2], paths });
  }
  return { truth, wire: makeWire(measured) };
}

const bitEqual = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  const bits = value => {
    const numbers = [];
    JSON.stringify(value, (_key, item) => { if (typeof item === 'number') numbers.push(item); return item; });
    return Buffer.from(Float64Array.from(numbers).buffer);
  };
  assert.ok(bits(actual).equals(bits(expected)), `${message}: Float64 bit sequence`);
};
const frozen = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); }
  return value;
};

test('physical truth ignores noise, specular selection and resolution; measurement matches the frozen producer', () => {
  let cases = 0;
  for (const scene of ['reference', 'layered']) {
    const base = normalizeInput({ scene, seed: 3, vehicles: 3, snapshots: 3, cellStep: .2 }), geometry = createSceneGeometry(base),
      raw = frozen(generateTruthSnapshot(base, geometry.spans, 3, geometry.wallModel));
    assert.equal(Object.hasOwn(raw, 'poseNoise'), false);
    for (const config of raw.configs) for (const point of [...config.specular, ...config.diffuse])
      assert.equal(Object.hasOwn(point, 'z'), false);
    const untouched = JSON.stringify(raw);
    for (const sigmaP of [0, .1, 2]) for (const sigmaD of [0, .05, .3, 2]) {
      if (sigmaP + sigmaD === 0) continue;
      for (const specular of [false, true]) for (const resolution of [0, .1, .5]) {
        const input = normalizeInput({ ...base, sigmaP, sigmaD, specular, resolution }),
          expected = originalGenerateSnapshot(input, geometry.spans, 3, geometry.wallModel);
        bitEqual(measureTruthSnapshot(input, raw), expected, `${scene}: ${sigmaP}/${sigmaD}/${specular}/${resolution}`);
        cases++;
      }
    }
    bitEqual(generateTruthSnapshot({ ...base, sigmaP: .3, sigmaD: 0, specular: false, resolution: 2 }, geometry.spans, 3, geometry.wallModel), raw,
      'Physical truth must not depend on observation settings');
    bitEqual(generateSnapshot(base, geometry.spans, 3, geometry.wallModel), originalGenerateSnapshot(base, geometry.spans, 3, geometry.wallModel),
      'Existing generateSnapshot composition preserves its contract');
    assert.equal(JSON.stringify(raw), untouched, 'Projection cannot mutate a cached snapshot');
  }
  assert.equal(cases, 132);
});

test('ten-vehicle truth gives bit-identical smaller fleets for every bank seed and selected time prefixes', () => {
  let cases = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const base = normalizeInput({ seed, vehicles: 10, snapshots: 120, cellStep: .2 }), geometry = createSceneGeometry(base);
    for (const t of [1, 60, 120]) {
      const raw = generateTruthSnapshot(base, geometry.spans, t, geometry.wallModel);
      for (const vehicles of [2, 3, 5, 10]) {
        const input = normalizeInput({ ...base, vehicles, snapshots: t, sigmaP: .2, sigmaD: .3, resolution: .1 });
        bitEqual(measureTruthSnapshot(input, raw), originalGenerateSnapshot(input, geometry.spans, t, geometry.wallModel),
          `seed ${seed}, snapshot ${t}, fleet ${vehicles}`);
        cases++;
      }
    }
  }
  assert.equal(cases, 120);
});

test('single walls, zero diffuse intensity and nominal cell spacing preserve pre-refactor outputs', () => {
  for (const wallSide of ['lower', 'upper']) for (const [roughness, lambda0] of [[0, 10], [2, 0], [2, 10]]) {
    const input = normalizeInput({ seed: 10, wallSide, vehicles: 3, snapshots: 2, roughness, lambda0, cellStep: .02,
      specular: false, resolution: .3 }), geometry = createSceneGeometry(input),
      raw = generateTruthSnapshot(input, geometry.spans, 2, geometry.wallModel), actual = measureTruthSnapshot(input, raw);
    bitEqual(actual, originalGenerateSnapshot(input, geometry.spans, 2, geometry.wallModel), 'single wall and zero-scattering cases');
    for (const config of actual.truth.configs) {
      assert.deepEqual(config.numericalDiagnostics, { degenerateSpans: [], unresolved: 0 });
      assert.equal(config.generated.specular, 0); assert.deepEqual(config.specular, []);
    }
  }
});

test('measurement owns result arrays and exposes only measured fields to estimators', () => {
  const input = normalizeInput({ scene: 'reference', vehicles: 3, snapshots: 1, cellStep: .2 }), geometry = createSceneGeometry(input),
    raw = generateTruthSnapshot(input, geometry.spans, 1), original = JSON.stringify(raw), result = measureTruthSnapshot(input, raw);
  for (const config of result.wire.configs) {
    assert.deepEqual(Object.keys(config).sort(), ['i', 'j', 'pHat_i', 'pHat_j', 'Sigma_i', 'Sigma_j', 'paths'].sort());
    for (const path of config.paths) assert.deepEqual(Object.keys(path).sort(), ['dHat', 'sigmaD']);
  }
  result.truth.p[0][0] = -999;
  const config = result.truth.configs[0];
  config.lambdaTotal[0] = -999; config.diffuseSampling.beforeThinning[0] = -999;
  config.numericalDiagnostics.degenerateSpans.push('modified');
  const point = config.specular[0] ?? config.diffuse[0]; assert.ok(point); point.s[0] = -999;
  assert.equal(JSON.stringify(raw), original, 'Consumers must not corrupt reusable raw truth');
});

test('projection rejects missing fleets, future snapshots and malformed pair arrays', () => {
  const input = normalizeInput({ scene: 'reference', vehicles: 3, snapshots: 3, cellStep: .2 }), geometry = createSceneGeometry(input),
    raw = generateTruthSnapshot(input, geometry.spans, 3);
  for (const t of [0, -1, 1.5, 4, NaN]) {
    assert.throws(() => generateTruthSnapshot(input, geometry.spans, t), /time prefix/);
    assert.throws(() => measureTruthSnapshot(input, { ...raw, t }), /time prefix/);
  }
  assert.throws(() => measureTruthSnapshot({ ...input, vehicles: 4 }, raw), /vehicle prefix/);
  assert.throws(() => measureTruthSnapshot({ ...input, snapshots: 2 }, raw), /time prefix/);
  assert.throws(() => measureTruthSnapshot(input, { ...raw, configs: raw.configs.slice(1) }), /every vehicle pair/);
  assert.throws(() => measureTruthSnapshot(input, { ...raw, configs: [...raw.configs].reverse() }), /canonical vehicle ID/);
  assert.throws(() => measureTruthSnapshot(input, { ...raw, p: [[NaN, 0], ...raw.p.slice(1)] }), /vehicle prefix/);
  assert.throws(() => measureTruthSnapshot({ ...input, sigmaP: -1 }, raw), /Position and range SD/);
  assert.throws(() => measureTruthSnapshot({ ...input, sigmaD: -1 }, raw), /Position and range SD/);
});

test('uncached scenario still composes identical causal prefixes', async () => {
  const input = normalizeInput({ scene: 'reference', seed: 3, vehicles: 3, snapshots: 3, cellStep: .2 }),
    scenario = await generateScenario(input);
  for (let t = 1; t <= input.snapshots; t++)
    bitEqual({ truth: scenario.truth[t - 1], wire: scenario.wire[t - 1] },
      originalGenerateSnapshot(input, scenario.spans, t, scenario.wallModel), `uncached prefix ${t}`);
});
