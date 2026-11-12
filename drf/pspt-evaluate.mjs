/** Post-hoc only. Never imported by pspt.mjs or its measurement worker.
 * Geometry is labelled at its current position, tolerance 0.4 m. Surface
 * coverage is restricted to wall samples within 1 m of past generated echoes.
 */
import { centreSpline, patchPoints } from './centre-spline.mjs';
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
  const walls = new Map(), pieces = [];
  if (scenario.spans?.length) {
    for (const span of scenario.spans) {
      const C = span.C, speedBound = [1, 2, 3].reduce((sum, k) => sum + k * Math.hypot(...C[k]), 0),
        count = Math.max(2, Math.ceil(speedBound / sampleStep) + 1), wall = span.wall ?? 0;
      const end=walls.get(wall)?.at(-1);
      // Separate physical components: never resample an imaginary wall across an opening.
      if (!end || Math.hypot(end[0]-C[0][0], end[1]-C[0][1])>1e-7) {
        const piece=[]; pieces.push(piece); walls.set(wall,piece);
      }
      for (let k = 0; k < count; k++) {
        const u = k / (count - 1);
        walls.get(wall).push([0, 1].map(axis => C.reduce((sum, coefficient, degree) => sum + coefficient[axis] * u ** degree, 0)));
      }
    }
  } else for (const points of scenario.walls) if (points.length) pieces.push(points);
  return pieces.flatMap(resamplePolyline).map(([x, y]) => ({ x, y }));
}

function surfelSamples(candidate) {
  return resamplePolyline(patchPoints(candidate)).map(([x, y]) => ({ x, y }));
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
function mapF1(length, outside, hits, total) {
  if (!total) return null;
  const p=length ? Math.max(0,1-outside/length) : 0, r=hits/total;
  return p+r ? 2*p*r/(p+r) : 0;
}

function assessBridges(bridges, shape, onWall, uncovered, observed, full) {
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
  const near = interior.length && neighborhood(interior);
  const recovered = near ? uncovered.filter(near).length : 0;
  const allHits = full.hits + recovered + (near ? full.unseenMisses.filter(near).length : 0);
  return { mapF1:mapF1(full.length+lengthM,full.outside+offWallM,allHits,full.total), count: bridges.length, lengthM, offWallM, falseBridges, observed, recovered,
    missing: uncovered.length - recovered, recall: fraction(observed - uncovered.length + recovered, observed) };
}

// Length-weight the actual map geometry. Centre links replace inward half-patches,
// so coverage must be recomputed over all observed samples, including previous hits.
function pathLength(points, onWall) {
  let lengthM=0, offWallM=0;
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i],ds=Math.hypot(b.x-a.x,b.y-a.y);
    lengthM+=ds;
    if(!onWall({x:(a.x+b.x)/2,y:(a.y+b.y)/2}))offWallM+=ds;
  }
  return {lengthM,offWallM};
}

function assessCentres(supported,onWall,observed,raw,gt,mask,bridges) {
  const {links,ends}=centreSpline(supported,bridges);
  if(!links.length)return {...raw};
  const samples=[];
  let lengthM=0,offWallM=0,falseBridges=0;
  const add=(path,link)=>{
    const points=path.map(([x,y])=>({x,y})), stat=pathLength(points,onWall);
    lengthM+=stat.lengthM; offWallM+=stat.offWallM;
    if(link && stat.offWallM>0)falseBridges++;
    samples.push(...points);
  };
  for(const end of ends)add(end,false);
  for(const link of links)add(link.points,true);
  const near=neighborhood(samples);
  let hits=0,allHits=0;
  for(let i=0;i<gt.length;i++) if(near(gt[i])){allHits++;if(mask[i])hits++;}
  return {mapF1:mapF1(lengthM,offWallM,allHits,gt.length),count:links.length,lengthM,offWallM,falseBridges,missing:observed.length-hits,recall:fraction(hits,observed.length)};
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
    let rawLengthM=0,rawOffWallM=0;
    for (const c of supported) {
      if (!firstSupport.has(c.id)) firstSupport.set(c.id, onWall({ x: c.center[0], y: c.center[1] }));
      const points=surfelSamples(c), stat=pathLength(points,onWall);
      rawLengthM+=stat.lengthM; rawOffWallM+=stat.offWallM; patches.push(...points);
    }
    const observed = gt.filter((_, k) => mask[k]), nearPatch = neighborhood(patches),
      precision = fraction(distances.filter(d => d <= tolerance).length, centers.length),
      surfacePrecision = fraction(patches.filter(onWall).length, patches.length),
      uncovered = observed.filter(p => !nearPatch(p)),
      recall = fraction(observed.length - uncovered.length, observed.length),
      f1 = recall == null ? null : !surfacePrecision ? 0 : 2 * surfacePrecision * recall / (surfacePrecision + recall),
      pending = frame.candidates.filter(c => c.status === 'pending').length;
    const unseenMisses=gt.filter((p,i)=>!mask[i] && !nearPatch(p));
    const full={length:rawLengthM,outside:rawOffWallM,hits:gt.length-uncovered.length-unseenMisses.length,total:gt.length,unseenMisses};
    const interpolation = assessBridges(bridges, 'points', onWall, uncovered, observed.length, full);
    if (extendedBridges) interpolation.extended = extendedBridges.length
      ? assessBridges([...bridges, ...extendedBridges], 'points', onWall, uncovered, observed.length, full)
      : {...interpolation};
    interpolation.hermite = assessBridges(bridges, 'curve', onWall, uncovered, observed.length, full);
    const rawMap={mapF1:mapF1(rawLengthM,rawOffWallM,full.hits,full.total),count:0,lengthM:rawLengthM,offWallM:rawOffWallM,falseBridges:0,missing:uncovered.length,recall};
    interpolation.centre=assessCentres(supported,onWall,observed,rawMap,gt,mask,bridges);
    interpolation.rawMap=rawMap;
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
    'extended_gaps','extended_map_recall','extended_added_m','extended_added_offwall_m','extended_false_bridges',
    'centre_links','centre_map_recall','centre_map_missed_samples','centre_map_length_m','centre_map_offwall_m','centre_offwall_links','raw_map_length_m','raw_map_offwall_m','raw_map_f1','linear_map_f1','hermite_map_f1','centre_map_f1','extended_map_f1');
  const rows = frames.map((f, k) => {
    const e = evaluations[k] ?? {};
    const row = [f.t, f.Q, f.admitted, f.rejected, e.supportedCount, e.pendingCount, e.rejectedCount,
      e.precision, e.recall, e.firstSupportPrecision, e.firstSupportErrors, e.firstSupportCount,
      e.f1, e.p95, e.offwall, e.holdRate, f.ms, f.psptMs];
    if (includeInterpolation) {
      const b = e.interpolation, h = b?.hermite;
      row.push(b?.count, b?.recall, b?.lengthM, b?.offWallM, h?.recall, h?.lengthM, h?.offWallM,
        b?.extended?.count, b?.extended?.recall, b?.extended?.lengthM, b?.extended?.offWallM, b?.extended?.falseBridges,
        b?.centre?.count,b?.centre?.recall,b?.centre?.missing,b?.centre?.lengthM,b?.centre?.offWallM,b?.centre?.falseBridges,b?.rawMap?.lengthM,b?.rawMap?.offWallM,b?.rawMap?.mapF1,b?.mapF1,h?.mapF1,b?.centre?.mapF1,b?.extended?.mapF1);
    }
    return row;
  });
  return '\ufeff' + [keys, ...rows].map(row => row.map(v => typeof v === 'number' && !Number.isFinite(v) ? '' : v ?? '').join(',')).join('\r\n') + '\r\n';
}
