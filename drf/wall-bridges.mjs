/** Linear map completion on the current supported fragments, in metres and radians.
 * Two outward tangents must face along the chord. At a branch both ends must
 * have exactly one partner. Inferred segments never become candidate endpoints.
 * With N patches, sorting costs O(N log N); pair checks are O(N²) worst case.
 */
export const BRIDGE_RULE = Object.freeze({ maxGap: "shorter full fragment", maxAngleDeg: 15, overlapDistanceM: 0.10 });
const cosine = Math.cos(BRIDGE_RULE.maxAngleDeg * Math.PI / 180);

export function wallBridges(candidates) {
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
  const bridges = [];
  for (const [a,b] of choices) {
    if (a.matches !== 1 || b.matches !== 1) continue;
    const midX = (a.point[0] + b.point[0]) / 2, midY = (a.point[1] + b.point[1]) / 2;
    const occupied = patches.some(({c, tx, ty, bend}) => {
      if (c === a.patch.c || c === b.patch.c) return false;
      const x = midX - c.center[0], y = midY - c.center[1], u = x * tx + y * ty;
      return Math.abs(u) <= c.ell && Math.abs(-x * ty + y * tx - 0.5 * bend * u * u) <= BRIDGE_RULE.overlapDistanceM;
    });
    if (!occupied) bridges.push({from: a.patch.c.id, to: b.patch.c.id, points: [a.point, b.point]});
  }
  return bridges;
}
