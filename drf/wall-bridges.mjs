import { RANGE_SUPPORT } from './bridge-evidence.mjs?v=20261112-chain-tips';

/** Linear map completion on the current supported fragments, in metres and radians.
 * Two outward tangents must face along the chord. At a branch both ends must
 * have exactly one partner. Inferred segments never become candidate endpoints.
 * With N patches, sorting costs O(N log N); pair checks are O(N²) worst case.
 */
export const BRIDGE_RULE = Object.freeze({ curve: "endpoint-hermite-single-bend-v1", maxGap: "shorter full fragment", maxAngleDeg: 15, overlapDistanceM: 0.10, extendedLengthFactor: 4, extendedMaxAngleDeg: 45, rangeSupport:RANGE_SUPPORT });
const cosine = Math.cos(BRIDGE_RULE.maxAngleDeg * Math.PI / 180);

export function wallBridges(candidates, extendedBridges = null, evidence = null, ambiguous = null) {
  const patches = [], ends = [];
  for (const c of candidates) {
    if (c.status !== 'supported') continue;
    const tx = Math.cos(c.phi), ty = Math.sin(c.phi), bend = c.sg * c.kappa;
    const patch = {c, tx, ty, bend};
    patches.push(patch);
    for (const sign of [-1, 1]) {
      const u = sign * c.ell, offset = 0.5 * bend * u * u, slope = bend * u;
      const scale = sign / Math.hypot(1, slope);
      ends.push({patch, point: [c.center[0] + u * tx - offset * ty, c.center[1] + u * ty + offset * tx],
        dx: scale * (tx - slope * ty), dy: scale * (ty + slope * tx), matches: 0});
    }
  }
  ends.sort((a, b) => a.point[0] - b.point[0]);
  const choices = [];
  for (let i = 0; i < ends.length; i++) {
    const a = ends[i];
    for (let j = i + 1; j < ends.length; j++) {
      const b = ends[j], dx = b.point[0] - a.point[0], dy = b.point[1] - a.point[1];
      if (dx > 2 * a.patch.c.ell) break;
      const gap = Math.hypot(dx, dy);
      if (a.patch === b.patch || gap < 1e-8 || gap > 2 * Math.min(a.patch.c.ell, b.patch.c.ell)) continue;
      if (a.dx * dx + a.dy * dy < cosine * gap || -(b.dx * dx + b.dy * dy) < cosine * gap ||
          -(a.dx * b.dx + a.dy * b.dy) < cosine) continue;
      a.matches++; b.matches++;
      choices.push([a,b]);
    }
  }
  const bridges = [], used = new Set();
  for (const [a,b] of choices) {
    if (a.matches !== 1 || b.matches !== 1) continue;
    const midX = (a.point[0] + b.point[0]) / 2, midY = (a.point[1] + b.point[1]) / 2;
    const occupied = patches.some(({c, tx, ty, bend}) => {
      if (c === a.patch.c || c === b.patch.c) return false;
      const x = midX - c.center[0], y = midY - c.center[1], u = x * tx + y * ty;
      return Math.abs(u) <= c.ell && Math.abs(-x * ty + y * tx - 0.5 * bend * u * u) <= BRIDGE_RULE.overlapDistanceM;
    });
    if (!occupied) {
      used.add(a); used.add(b);
      bridges.push({from: a.patch.c.id, to: b.patch.c.id, points: [a.point, b.point]});
    }
  }
  if (extendedBridges || evidence) addExtendedBridges(patches, ends, used, extendedBridges, bridges, evidence, ambiguous);
  return bridges;
}

// Extra linear links for inspecting wider gaps. Only exposed tips of supported
// pieces are eligible. With N pieces and S chord samples, the occupancy veto
// costs O(S*N) per plausible pair. An added link never becomes a new endpoint.
function addExtendedBridges(patches, ends, used, extra, bridges, evidence, ambiguous) {
  const wideCosine = Math.cos(BRIDGE_RULE.extendedMaxAngleDeg * Math.PI / 180);
  const spanFactor = 2 * BRIDGE_RULE.extendedLengthFactor;
  function covered(x, y, first, second) {
    return patches.some(patch => {
      if (patch === first || patch === second) return false;
      const cx = x - patch.c.center[0], cy = y - patch.c.center[1];
      const u = cx * patch.tx + cy * patch.ty;
      const residual = -cx * patch.ty + cy * patch.tx - 0.5 * patch.bend * u * u;
      return Math.abs(u) < patch.c.ell && Math.abs(residual) <= BRIDGE_RULE.overlapDistanceM;
    });
  }
  // A point 5 cm beyond an internal tip is already covered by its neighbour.
  const exposed = ends.filter(e => !used.has(e) &&
    !covered(e.point[0] + 0.05 * e.dx, e.point[1] + 0.05 * e.dy, e.patch));
  const choices = [], degree = new Map();
  for (let i = 0; i < exposed.length; i++) {
    const a = exposed[i];
    for (let j = i + 1; j < exposed.length; j++) {
      const b = exposed[j], dx = b.point[0] - a.point[0], dy = b.point[1] - a.point[1];
      if (dx > spanFactor * a.patch.c.ell) break;
      const gap = Math.hypot(dx, dy);
      if (a.patch === b.patch || gap < 1e-8 || gap > spanFactor * Math.min(a.patch.c.ell, b.patch.c.ell)) continue;
      if (a.dx * dx + a.dy * dy < wideCosine * gap || -(b.dx * dx + b.dy * dy) < wideCosine * gap ||
          -(a.dx * b.dx + a.dy * b.dy) < wideCosine) continue;
      const steps = Math.max(2, Math.ceil(gap / 0.2));
      let occupied = false;
      for (let k = 1; k < steps && !occupied; k++)
        occupied = covered(a.point[0] + dx * k / steps, a.point[1] + dy * k / steps, a.patch, b.patch);
      if (occupied) continue;
      choices.push([a, b]);
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
    }
  }
  for (const [a, b] of choices) {
    const link = {from:a.patch.c.id, to:b.patch.c.id, points:[a.point, b.point]};
    if (degree.get(a) !== 1 || degree.get(b) !== 1) { ambiguous?.push(link); continue; }
    const dx = b.point[0] - a.point[0], dy = b.point[1] - a.point[1], gap = Math.hypot(dx,dy);
    if (evidence && a.dx*dx + a.dy*dy >= cosine*gap && -(b.dx*dx + b.dy*dy) >= cosine*gap &&
        -(a.dx*b.dx + a.dy*b.dy) >= cosine && evidence.confirms(link.points)) {
      bridges.push({...link, measuredLinear:true});
    } else {
      extra?.push(link);
    }
  }
}
