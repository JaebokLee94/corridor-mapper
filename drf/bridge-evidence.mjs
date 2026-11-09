// Tests a proposed straight span against measured bistatic ranges up through t.
// The estimator and its thresholds operate independently of these map links.
export const RANGE_SUPPORT = Object.freeze({
  binLengthM:1, binPaddingM:0.3, minIncidenceCos:0.8, minPairs:4, minSnapshots:3,
  minMatchFraction:0.75, minControlMargin:0.5, maxRangeBandM:0.18, noiseMultiplier:1.5, controlBands:4,
});
function hasRange(ranges, target, band) {
  let lo = 0, hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid] < target - band) lo = mid + 1;
    else hi = mid;
  }
  return lo < ranges.length && ranges[lo] <= target + band;
}

function countSnapshot(link, pairs, band) {
  const {x, y, tx, ty, length, hits} = link, width = length / hits.length;
  const counts = new Uint16Array(4 * hits.length);
  for (const {ix, iy, jx, jy, ranges} of pairs) {
    const ui = (ix-x)*tx + (iy-y)*ty, uj = (jx-x)*tx + (jy-y)*ty;
    const di = -(ix-x)*ty + (iy-y)*tx, dj = -(jx-x)*ty + (jy-y)*tx;
    if (di * dj <= 0) continue;
    // Mirroring one vehicle in the line gives the reflection coordinate and path length.
    const s = (ui*dj + uj*di) / (di + dj);
    if (s < -RANGE_SUPPORT.binPaddingM || s > length + RANGE_SUPPORT.binPaddingM) continue;
    const range = Math.hypot(ui - uj, di + dj);
    if (Math.abs(di + dj) < RANGE_SUPPORT.minIncidenceCos * range) continue;
    const centre = hasRange(ranges, range, band);
    const lower = hasRange(ranges, range - RANGE_SUPPORT.controlBands * band, band), upper = hasRange(ranges, range + RANGE_SUPPORT.controlBands * band, band);
    for (let bin=0; bin<hits.length; bin++) {
      if (hits[bin] >= RANGE_SUPPORT.minSnapshots || Math.abs((bin+0.5)*width - s) > 0.5*width + RANGE_SUPPORT.binPaddingM) continue;
      const k = 4*bin;
      counts[k]++; counts[k+1] += centre; counts[k+2] += lower; counts[k+3] += upper;
    }
  }
  for (let b=0; b<hits.length; b++) {
    const i = 4*b, total = counts[i], centre = counts[i+1];
    const control = Math.max(counts[i+2], counts[i+3]);
    if (total >= RANGE_SUPPORT.minPairs && centre >= RANGE_SUPPORT.minMatchFraction * total &&
        centre - control >= RANGE_SUPPORT.minControlMargin * total) hits[b]++;
  }
}

/** Keep measured poses/ranges for past snapshots. confirms([A,B]) tests a
 * unique, tangent-aligned chord [m]. Each <=1 m bin needs three matching times.
 * For stable endpoints process only new snapshots. Worst-case for a new chord:
 * O(T * pairs * (log(paths per pair) + bins)); storage O(all measured ranges).
 */
export class GapRangeEvidence {
  constructor(sigmaD) {
    this.band = Math.min(RANGE_SUPPORT.maxRangeBandM, RANGE_SUPPORT.noiseMultiplier * sigmaD);
    this.history = [];
    this.cache = new Map();
    this.previous = new Map();
  }

  add(wire) {
    this.previous = this.cache;
    this.cache = new Map();
    this.history.push(wire.configs.map(c => ({
      ix:c.pHat_i[0], iy:c.pHat_i[1], jx:c.pHat_j[0], jy:c.pHat_j[1],
      ranges:c.paths.map(p => p.dHat).sort((a,b) => a-b),
    })));
  }

  confirms(points) {
    const [[x,y],[bx,by]] = points, key = [x,y,bx,by].join(',');
    let span = this.cache.get(key) ?? this.previous.get(key);
    if (!span) {
      const length = Math.hypot(bx-x, by-y);
      span = {x, y, length, tx:(bx-x)/length, ty:(by-y)/length,
        hits:new Uint8Array(Math.max(2, Math.ceil(length / RANGE_SUPPORT.binLengthM))), seen:0, confirmed:false};
    }
    this.cache.set(key, span);
    while (!span.confirmed && span.seen < this.history.length) {
      countSnapshot(span, this.history[span.seen++], this.band);
      span.confirmed = span.hits.every(n => n >= RANGE_SUPPORT.minSnapshots);
    }
    return span.confirmed;
  }
}
