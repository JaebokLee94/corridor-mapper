/** Truth-side simulator. Units: m and rad; no estimator output is read here.
 * Input: experiment settings. Output: truth and a separately copied measurement wire.
 * C = V(V-1)/2 unordered Tx/Rx pairs, V in [2,20].
 * Work per snapshot: O(C * (wall cells + emitted paths * visibility cost)).
 */
import { createWalls, sampleWalls, createTwoLayerWallModel, evaluateCentre, evaluateWall,
  twoLayerWallSpans, twoLayerWallBounds } from './wall.mjs?v=20261022-independent2';
import { specularPoints } from './specular.mjs?v=20261002-model8';
import { diffuseProfile, sampleDiffuse } from './diffuse.mjs?v=20261002-model8';
import { createRng } from './rng.mjs';
import { makeWire } from './wire.mjs';

export const DEFAULT_INPUT = Object.freeze({
  scene: 'layered', wallSide: 'both', vehicles: 10, snapshots: 120, sigmaP: 0.1, sigmaD: 0.1,
  sigmaM: 6, deltaM: 20, sigmaDGeometry: 0.33, deltaD: 4,
  roughness: 2, lambda0: 10, cellStep: 0.02, resolution: 0, specular: true,
  grid: 150, band: 4, perimeter: 'exact', seed: 1,
});
export function normalizeInput(raw = {}) {
  const p = {};
  for (const key of Object.keys(DEFAULT_INPUT)) p[key] = raw[key] ?? DEFAULT_INPUT[key];
  for (const key of ['vehicles', 'snapshots', 'sigmaP', 'sigmaD', 'sigmaM', 'deltaM', 'sigmaDGeometry', 'deltaD', 'roughness', 'lambda0', 'cellStep', 'resolution', 'grid', 'seed']) {
    p[key] = Number(p[key]);
    if (!Number.isFinite(p[key])) throw new Error(`${key}: finite number required`);
  }
  p.band = p.band === 'full' ? 'full' : Number(p.band);
  p.specular = p.specular === true || p.specular === 'true';
  if (!['layered', 'reference', 'random'].includes(p.scene)) throw new Error('Unknown corridor scene');
  if (!['both', 'upper', 'lower'].includes(p.wallSide)) throw new Error('Wall side must be both, upper or lower');
  if (!Number.isInteger(p.vehicles) || p.vehicles < 2 || p.vehicles > 20 || !Number.isInteger(p.snapshots) || p.snapshots < 1 || p.snapshots > 120)
    throw new Error('Reference trajectories support 2–20 vehicles and 1–120 snapshots');
  if (![100, 150, 200].includes(p.grid) || ![3, 4, 5, 'full'].includes(p.band) || !['exact', 'ramanujan'].includes(p.perimeter))
    throw new Error('Unsupported numerical setting');
  if (p.sigmaP < 0 || p.sigmaD < 0 || p.sigmaP > 2 || p.sigmaD > 2 || p.sigmaP + p.sigmaD === 0)
    throw new Error('Position and range SD must be within 0–2 m, with at least one greater than zero.');
  if (p.roughness < 0 || p.roughness > 20 || p.lambda0 < 0 || p.lambda0 > 30 || p.cellStep < 0.005 || p.cellStep > 0.2 || p.resolution < 0 || p.resolution > 2)
    throw new Error('Scattering settings are outside the supported range');
  if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xffffffff) throw new Error('Seed must be a uint32');
  if (p.sigmaM < 0 || p.sigmaM > 12 || p.sigmaDGeometry < 0 || p.sigmaDGeometry > 3
    || p.deltaM < 4 || p.deltaM > 60 || p.deltaD < 1 || p.deltaD > 20)
    throw new Error('Geometry limits: wall-shape amplitude 0–12 m, spacing 4–60 m; perturbation amplitude 0–3 m, spacing 1–20 m.');
  return p;
}
export const LAYERED_DOMAIN = Object.freeze([0, 80, -20, 50]);
const LATERAL_AMPLITUDE = 2, VERTICAL_CLEARANCE = 1;
// Every vehicle stays within midpoint ±2 m. A 6 m gap leaves ≥1 m on
// either side for every phase, including between snapshots (truth poses).
const MIN_VERTICAL_GAP = 2 * (LATERAL_AMPLITUDE + VERTICAL_CLEARANCE);
/** Truth-only rejection against the fixed supported fleet, independent of V/T,
 * noise and estimator settings. Clearance is vertical at each pose's x, like W.
 * Work O(attempts*(spans*log(spans) + 20*120)); attempts are bounded.
 * Accepted statistics are conditional on this protocol, not iid Gaussian walls. */
export function createSceneGeometry(input) {
  const wallSide = input.wallSide ?? 'both', activeWalls = wallSide === 'both' ? [0, 1] : [wallSide === 'lower' ? 0 : 1];
  if (input.scene !== 'layered') {
    const spans = createWalls(input).filter(span => activeWalls.includes(span.wall));
    return { spans, walls: sampleWalls(spans, 0.1), wallModel: null, domain: [0, 60, 0, 30], wallGeneration: null };
  }
  const rejections = [];
  for (let attempt = 0; attempt < 256; attempt++) {
    const wallModel = createTwoLayerWallModel({ ...input, wallSide, L: LAYERED_DOMAIN[1], attempt,
      independent: wallSide === 'both', minWidth: MIN_VERTICAL_GAP }), bounds = twoLayerWallBounds(wallModel), reasons = [];
    if (wallSide === 'both' && !(bounds.minWidth > MIN_VERTICAL_GAP)) reasons.push('passage-width');
    if (bounds.ymin < LAYERED_DOMAIN[2] || bounds.ymax > LAYERED_DOMAIN[3]) reasons.push('domain');
    let minVehicleClearance = Infinity;
    for (let t = 1; t <= 120; t++) for (const [x, y] of truePoses(t, 20, wallModel)) {
      if (x > wallModel.L) continue; // Open exit: poses continue, finite walls do not.
      for (const wall of activeWalls) minVehicleClearance = Math.min(minVehicleClearance,
        wall === 0 ? y - evaluateWall(wallModel, x, wall).value : evaluateWall(wallModel, x, wall).value - y);
    }
    if (minVehicleClearance < VERTICAL_CLEARANCE) reasons.push('vehicle-clearance');
    if (reasons.length) { rejections.push({ attempt, reasons }); continue; }
    const spans = twoLayerWallSpans(wallModel);
    return { spans, walls: sampleWalls(spans, 0.1), wallModel, domain: [...LAYERED_DOMAIN],
      // Static display envelope: existing wall + all centreline offsets, never future measurements.
      ...(wallSide === 'both' ? {} : { cameraBounds: [0, wallModel.L,
        Math.min(bounds.ymin, bounds.centreRange[0] - 2), Math.max(bounds.ymax, bounds.centreRange[1] + 2)] }),
      wallGeneration: { attempt, attempts: attempt + 1, rejections, bounds, minVehicleClearance,
        wallSide, activeWalls, minWidthRequired: wallSide === 'both' ? MIN_VERTICAL_GAP : null,
        vehicleClearanceRequired: VERTICAL_CLEARANCE, clearanceAxis: 'y',
        validationFleet: { vehicles: 20, snapshots: 120, wallInterval: [0, wallModel.L] } } };
  }
  throw new Error('All 256 wall-generation attempts were rejected. Reduce geometry amplitudes or choose another seed.');
}
export function truePoses(t, vehicles = 3, wallModel = null) {
  return Array.from({ length: vehicles }, (_, v) => {
    // Fixed initial slots and RNG addresses keep fleet prefixes equal.
    // Layered routes advance 80 m in 120 snapshots (2/3 m per snapshot).
    // Legacy reference/random routes retain 0.75 m per snapshot for fixture parity.
    // Neither route depends on requested duration or clamps the final position.
    // Only the centreline is tangent-continued beyond the finite open exit.
    const x0 = v < 3 ? 4 + 3 * v : 1 + 13 * (v - 3) / 16;
    const stepM = wallModel ? 2 / 3 : 0.75;
    const x = x0 + stepM * t;
    const wallX = Math.min(x, wallModel?.L ?? 60),
      centre = wallModel ? evaluateCentre(wallModel, wallX) : { value: 15, first: 0 };
    // The route follows the finished walls' midpoint. The full lateral motion
    // is retained; wall separation supplies clearance instead of shrinking it.
    return [x, centre.value + centre.first * Math.max(0, x - (wallModel?.L ?? 60)) + LATERAL_AMPLITUDE * Math.sin(2 * Math.PI * x / 30 + v + 1)];
  });
}
/** Independent streams preserve standard pose/specular noise across paired sweeps. */
export function generateSnapshot(input, spans, t, wallModel = null) {
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
export async function generateScenario(raw, progress = () => {}) {
  const started = performance.now(), input = normalizeInput(raw), geometry = createSceneGeometry(input);
  const truth = [], wire = [];
  for (let t = 1; t <= input.snapshots; t++) {
    const result = generateSnapshot(input, geometry.spans, t, geometry.wallModel);
    truth.push(result.truth); wire.push(result.wire); progress(t, input.snapshots);
    // Yield only on the truth side; the estimator still receives one causal snapshot at a time.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { input, ...geometry, truth, wire, simulatorMs: performance.now() - started };
}
