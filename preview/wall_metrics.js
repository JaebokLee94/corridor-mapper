/*
 * Geometry-only wall-map metrics.
 * Ground truth and simulated hit points are evaluator inputs only; estimator
 * code must never import this module or receive observedMask.
 */
(function attachWallMetrics(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WallMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildWallMetrics() {
  'use strict';

  const EPS = 1e-12;

  function finitePoint(point) {
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
  }

  function samplePolylineArcLength(polyline, spacing = 0.2, wallId = 0) {
    const input = Array.isArray(polyline) ? polyline.filter(finitePoint) : [];
    if (input.length < 2) return input.map((point) => ({ x: point.x, y: point.y, wallId, s: 0 }));
    const ds = Math.max(1e-3, Number.isFinite(spacing) ? spacing : 0.2);
    const segmentLengths = new Float64Array(input.length - 1);
    const cumulative = new Float64Array(input.length);
    for (let index = 0; index < input.length - 1; index++) {
      segmentLengths[index] = Math.hypot(input[index + 1].x - input[index].x, input[index + 1].y - input[index].y);
      cumulative[index + 1] = cumulative[index] + segmentLengths[index];
    }
    const totalLength = cumulative.at(-1);
    if (!(totalLength > EPS)) return [{ x: input[0].x, y: input[0].y, wallId, s: 0 }];
    const closed = Math.hypot(input[0].x - input.at(-1).x, input[0].y - input.at(-1).y) <= 1e-6;
    const count = Math.max(2, closed ? Math.ceil(totalLength / ds) : Math.floor(totalLength / ds) + 1);
    const samples = [];
    let segment = 0;
    for (let sampleIndex = 0; sampleIndex < count; sampleIndex++) {
      const s = closed
        ? sampleIndex * totalLength / count
        : Math.min(totalLength, sampleIndex * totalLength / (count - 1));
      while (segment < segmentLengths.length - 1 && cumulative[segment + 1] < s) segment++;
      const length = Math.max(EPS, segmentLengths[segment]);
      const fraction = Math.max(0, Math.min(1, (s - cumulative[segment]) / length));
      const p0 = input[segment];
      const p1 = input[segment + 1];
      samples.push({
        x: p0.x * (1 - fraction) + p1.x * fraction,
        y: p0.y * (1 - fraction) + p1.y * fraction,
        wallId,
        s,
      });
    }
    return samples;
  }

  function sampleWallsArcLength(walls, spacing = 0.2) {
    const out = [];
    const list = Array.isArray(walls) ? walls : [];
    for (let wallId = 0; wallId < list.length; wallId++) {
      out.push(...samplePolylineArcLength(list[wallId], spacing, wallId));
    }
    return out;
  }

  function createObservedMask(gtPoints) {
    return new Uint8Array(Array.isArray(gtPoints) ? gtPoints.length : 0);
  }

  function markObservedGT(gtPoints, observedMask, hits, radius = 1.0) {
    const gt = Array.isArray(gtPoints) ? gtPoints : [];
    const list = Array.isArray(hits) ? hits : [];
    if (!(observedMask instanceof Uint8Array) || observedMask.length !== gt.length) {
      throw new Error('observedMask length must equal gtPoints length');
    }
    const r2 = Math.max(0, radius) ** 2;
    for (const hit of list) {
      if (!finitePoint(hit)) continue;
      for (let index = 0; index < gt.length; index++) {
        if (observedMask[index]) continue;
        const dx = gt[index].x - hit.x;
        const dy = gt[index].y - hit.y;
        if (dx * dx + dy * dy <= r2) observedMask[index] = 1;
      }
    }
    return observedMask;
  }

  function nearestDistance(point, points) {
    let best = Infinity;
    for (const candidate of points) {
      const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
      if (distance < best) best = distance;
    }
    return best;
  }

  function mean(values) {
    if (!values.length) return Infinity;
    let sum = 0;
    for (const value of values) sum += value;
    return sum / values.length;
  }

  function percentile(values, probability) {
    if (!values.length) return Infinity;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1));
    return sorted[index];
  }

  function computeBoundaryMetrics(predictedPoints, gtPoints, observedMask, tolerance = 0.4) {
    const predicted = Array.isArray(predictedPoints) ? predictedPoints.filter(finitePoint) : [];
    const gt = Array.isArray(gtPoints) ? gtPoints.filter(finitePoint) : [];
    const maskValid = observedMask instanceof Uint8Array && observedMask.length === gt.length;
    const observedGT = maskValid ? gt.filter((_, index) => observedMask[index]) : gt;
    const coverage = gt.length ? observedGT.length / gt.length : 0;
    const tau = Math.max(0, Number.isFinite(tolerance) ? tolerance : 0.4);
    if (!predicted.length || !gt.length || !observedGT.length) {
      return { precision: 0, recall: 0, f1: 0, caMsd: Infinity, caHd95: Infinity, coverage, predictedCount: predicted.length, observedGTCount: observedGT.length };
    }

    // All predictions are evaluated against the full wall so hallucinated
    // interior structures remain false positives. Completeness is restricted
    // to the causally observed GT subset to avoid penalizing unexplored walls.
    const predictedDistances = predicted.map((point) => nearestDistance(point, gt));
    const observedDistances = observedGT.map((point) => nearestDistance(point, predicted));
    const precision = predictedDistances.filter((distance) => distance <= tau).length / predictedDistances.length;
    const recall = observedDistances.filter((distance) => distance <= tau).length / observedDistances.length;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    // These are coverage-aware distances, not standard ASSD/HD95: the two
    // directed terms deliberately use different GT supports.
    const caMsd = 0.5 * (mean(predictedDistances) + mean(observedDistances));
    const caHd95 = Math.max(percentile(predictedDistances, 0.95), percentile(observedDistances, 0.95));
    return { precision, recall, f1, caMsd, caHd95, coverage, predictedCount: predicted.length, observedGTCount: observedGT.length };
  }

  return {
    samplePolylineArcLength,
    sampleWallsArcLength,
    createObservedMask,
    markObservedGT,
    nearestDistance,
    computeBoundaryMetrics,
  };
});
