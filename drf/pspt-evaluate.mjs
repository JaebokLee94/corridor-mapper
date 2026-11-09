/** Post-hoc only. Never imported by pspt.mjs or its measurement worker.
 * Geometry is labelled at its current position, tolerance 0.4 m. Surface
 * coverage is restricted to wall samples within 1 m of past generated echoes.
 */
import { percentile } from './statistics.mjs';
import { createReflectionDiagnostics } from './reflection-diagnostics.mjs';
import '../wall_metrics.js';
const metrics = globalThis.WallMetrics, tolerance = 0.4, sampleStep = 0.05;
const fraction = (a, b) => b ? a / b : null;

/** Python evaluate_runs.py sampling: O(vertices + samples), Float64 metres.
 * Keep the original cumulative distance when dropping consecutive duplicates;
 * ceil(length / step) + 1 includes both endpoints with spacing <= 0.05 m. */
function resamplePolyline(points) {
  if (points.length < 2) return points;
  const cumulative = [0];
  for (let k = 1; k < points.length; k++) cumulative.push(cumulative[k - 1]
    + Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]));
  const kept = [], distance = [];
  for (let k = 0; k < points.length; k++) if (!k || cumulative[k] - cumulative[k - 1] > 1e-12) {
    kept.push(points[k]); distance.push(cumulative[k]);
  }
  if (kept.length < 2) return kept;
  const length = distance.at(-1), count = Math.max(2, Math.ceil(length / sampleStep) + 1), result = [];
  let segment = 0;
  for (let k = 0; k < count; k++) {
    const s = k === count - 1 ? length : k * (length / (count - 1));
    while (segment < kept.length - 2 && distance[segment + 1] < s) segment++;
    const weight = (s - distance[segment]) / (distance[segment + 1] - distance[segment]);
    result.push(kept[segment].map((value, axis) => value + weight * (kept[segment + 1][axis] - value)));
  }
  return result;
}

function wallSamples(scenario) {
  const walls = new Map();
  if (scenario.spans?.length) {
    for (const span of scenario.spans) {
      const C = span.C, speedBound = [1, 2, 3].reduce((sum, k) => sum + k * Math.hypot(...C[k]), 0),
        count = Math.max(2, Math.ceil(speedBound / sampleStep) + 1), wall = span.wall ?? 0;
      if (!walls.has(wall)) walls.set(wall, []);
      for (let k = 0; k < count; k++) {
        const u = k / (count - 1);
        walls.get(wall).push([0, 1].map(axis => C.reduce((sum, coefficient, degree) => sum + coefficient[axis] * u ** degree, 0)));
      }
    }
  } else for (const [wall, points] of scenario.walls.entries()) if (points.length) walls.set(wall, points);
  return [...walls.values()].flatMap(resamplePolyline).map(([x, y]) => ({ x, y }));
}

function surfelSamples(candidate) {
  const { center, ell, kappa, phi, sg } = candidate,
    count = Math.max(2, Math.ceil(2 * ell * Math.hypot(1, kappa * ell) / sampleStep) + 1),
    tx = Math.cos(phi), ty = Math.sin(phi), nx = -sg * ty, ny = sg * tx, points = [];
  for (let k = 0; k < count; k++) {
    const u = k === count - 1 ? ell : -ell + k * (2 * ell / (count - 1));
    points.push([center[0] + u * tx + 0.5 * kappa * u * u * nx,
      center[1] + u * ty + 0.5 * kappa * u * u * ny]);
  }
  return resamplePolyline(points).map(([x, y]) => ({ x, y }));
}

function neighborhood(points) {
  const cells = new Map();
  for (const p of points) {
    const key = `${Math.floor(p.x / tolerance)},${Math.floor(p.y / tolerance)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }
  return p => {
    const ix = Math.floor(p.x / tolerance), iy = Math.floor(p.y / tolerance);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      for (const q of cells.get(`${ix + dx},${iy + dy}`) ?? [])
        if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 <= tolerance ** 2) return true;
    return false;
  };
}

// Use the rendered polyline, split into equal arc-length bins <=5 cm. Each
// midpoint contributes its bin length to the off-wall total. Both raw endpoints
// are already covered by the estimated patches. Truth is read only here.
function assessBridges(bridges, shape, onWall, uncovered, observed) {
  const interior = [];
  let lengthM = 0, offWallM = 0, falseBridges = 0;
  for (const bridge of bridges) {
    const vertices = resamplePolyline(bridge[shape] ?? bridge.points);
    let outside = 0;
    for (let k = 1; k < vertices.length; k++) {
      const a = vertices[k-1], b = vertices[k], ds = Math.hypot(b[0]-a[0], b[1]-a[1]);
      const mid = {x:(a[0]+b[0])/2, y:(a[1]+b[1])/2};
      interior.push(mid); lengthM += ds;
      if (!onWall(mid)) outside += ds;
    }
    offWallM += outside;
    if (outside > 0) falseBridges++;
  }
  const recovered = interior.length ? uncovered.filter(neighborhood(interior)).length : 0;
  return { count: bridges.length, lengthM, offWallM, falseBridges, observed, recovered,
    missing: uncovered.length - recovered, recall: fraction(observed - uncovered.length + recovered, observed) };
}

export function createPSPTEvaluator(scenario, grid) {
  const diagnostic = createReflectionDiagnostics(scenario),
    gt = wallSamples(scenario),
    mask = metrics.createObservedMask(gt), onWall = neighborhood(gt), firstSupport = new Map();
  let cursor = 0;
  return { step(frame, sharedDiagnostics = null, bridges = [], extendedBridges) {
    if (!Array.isArray(frame.candidates)) throw new Error('PSPT evaluation requires estimator candidates');
    if (!Number.isInteger(frame.t) || frame.t < cursor || frame.t > scenario.truth.length) throw new Error('Evaluation requires a causal snapshot');
    while (cursor < frame.t) {
      const hits = scenario.truth[cursor++].configs.flatMap(c => [...c.specular, ...c.diffuse].map(q => ({ x: q.s[0], y: q.s[1] })));
      metrics.markObservedGT(gt, mask, hits, 1);
    }
    const supported = frame.candidates.filter(c => c.status === 'supported'),
      centers = supported.map(c => ({ x: c.center[0], y: c.center[1] })),
      distances = centers.map(p => metrics.nearestDistance(p, gt)), patches = [];
    for (const c of supported) {
      if (!firstSupport.has(c.id)) firstSupport.set(c.id, onWall({ x: c.center[0], y: c.center[1] }));
      patches.push(...surfelSamples(c));
    }
    const observed = gt.filter((_, k) => mask[k]), nearPatch = neighborhood(patches),
      precision = fraction(distances.filter(d => d <= tolerance).length, centers.length),
      surfacePrecision = fraction(patches.filter(onWall).length, patches.length),
      uncovered = observed.filter(p => !nearPatch(p)),
      recall = fraction(observed.length - uncovered.length, observed.length),
      f1 = recall == null ? null : !surfacePrecision ? 0 : 2 * surfacePrecision * recall / (surfacePrecision + recall),
      pending = frame.candidates.filter(c => c.status === 'pending').length;
    const interpolation = assessBridges(bridges, 'points', onWall, uncovered, observed.length);
    if (extendedBridges) interpolation.extended = extendedBridges.length
      ? assessBridges([...bridges, ...extendedBridges], 'points', onWall, uncovered, observed.length)
      : {...interpolation};
    interpolation.hermite = assessBridges(bridges.filter(b => !b.measuredLinear), 'curve', onWall, uncovered, observed.length);
    const diagnostics = sharedDiagnostics?.diagnostics ?? diagnostic.step(frame.t);
    return { t: frame.t, diagnostics, method: frame.method ?? 'guarded45', proxy: centers.map(p => [p.x, p.y]), observed: observed.map(p => [p.x, p.y]),
      medianError: percentile(distances, .5), p95: percentile(distances, .95), offwall: precision == null ? null : 1 - precision,
      precision, surfacePrecision, recall, f1, interpolation,
      observedFraction: fraction(observed.length, gt.length), missing: uncovered.length,
      firstSupportPrecision: fraction([...firstSupport.values()].filter(Boolean).length, firstSupport.size),
      firstSupportErrors: [...firstSupport.values()].filter(x => !x).length, firstSupportCount: firstSupport.size,
      holdRate: fraction(pending, frame.candidates.length), supportedCount: supported.length, pendingCount: pending,
      rejectedCount: frame.candidates.filter(c => c.status === 'contradicted').length,
      metricDefinition: 'Current centers and supported patches sampled approximately uniformly in arc length at <=0.05 m; cubic wall spans preferred. 0.4 m tolerance; past-echo 1 m observed mask. Overlapping patches count repeatedly. Empty precision is null.',
    };
  } };
}

/** Numeric snapshot export. Empty precision stays blank rather than becoming 0/1. */
export function psptSnapshotCsv(frames, evaluations, {includeInterpolation = false} = {}) {
  const keys = ['snapshot', 'Q', 'admitted', 'rejected', 'supported', 'pending', 'contradicted',
    'center_precision', 'observed_wall_recall', 'first_support_precision', 'first_support_errors',
    'first_support_count', 'surface_f1', 'p95_m', 'offwall_fraction', 'hold_fraction', 'field_ms', 'pspt_ms'];
  if (includeInterpolation) keys.push('interpolated_gaps', 'linear_map_recall', 'linear_added_m', 'linear_added_offwall_m',
    'hermite_map_recall', 'hermite_added_m', 'hermite_added_offwall_m',
    'extended_gaps','extended_map_recall','extended_added_m','extended_added_offwall_m','extended_false_bridges');
  const rows = frames.map((f, k) => {
    const e = evaluations[k] ?? {};
    const row = [f.t, f.Q, f.admitted, f.rejected, e.supportedCount, e.pendingCount, e.rejectedCount,
      e.precision, e.recall, e.firstSupportPrecision, e.firstSupportErrors, e.firstSupportCount,
      e.f1, e.p95, e.offwall, e.holdRate, f.ms, f.psptMs];
    if (includeInterpolation) {
      const b = e.interpolation, h = b?.hermite;
      row.push(b?.count, b?.recall, b?.lengthM, b?.offWallM, h?.recall, h?.lengthM, h?.offWallM,
        b?.extended?.count, b?.extended?.recall, b?.extended?.lengthM, b?.extended?.offWallM, b?.extended?.falseBridges);
    }
    return row;
  });
  return '\ufeff' + [keys, ...rows].map(row => row.map(v => typeof v === 'number' && !Number.isFinite(v) ? '' : v ?? '').join(',')).join('\r\n') + '\r\n';
}
