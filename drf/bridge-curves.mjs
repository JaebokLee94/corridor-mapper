import { wallBridges } from './wall-bridges.mjs';

/** Preserve the same unique endpoint pairs for both display modes. Only their
 * geometry changes. Hermite is cubic across the chord and linear along it, so
 * the curve cannot turn back. Outward tangent checks bound its endpoint slopes.
 * Input: this method's candidates in metres/radians; output: two polylines per
 * gap. Extra work/memory O(candidates + total displayed vertices).
 */
export function completeWallGaps(candidates, extendedBridges = null) {
  const bridges = wallBridges(candidates, extendedBridges);
  if (!bridges.length) return bridges;
  const byId = new Map(candidates.map(c => [c.id,c]));
  for (const bridge of bridges) {
    const [a,b] = bridge.points, length = Math.hypot(b[0]-a[0], b[1]-a[1]);
    const tx = (b[0]-a[0])/length, ty = (b[1]-a[1])/length;
    const slope = (point,c) => {
      const cos = Math.cos(c.phi), sin = Math.sin(c.phi);
      const u = (point[0]-c.center[0])*cos + (point[1]-c.center[1])*sin;
      const bend = c.kappa*c.sg*u, x = cos-bend*sin, y = sin+bend*cos;
      return (-ty*x+tx*y)/(tx*x+ty*y);
    };
    const m0 = slope(a,byId.get(bridge.from)), m1 = slope(b,byId.get(bridge.to));
    const n = Math.max(4,Math.ceil(length/0.05)), curve = [a];
    for (let i=1;i<n;i++) {
      const s=i/n, normal=length*s*(1-s)*((1-s)*m0-s*m1);
      curve.push([a[0]+s*length*tx-normal*ty, a[1]+s*length*ty+normal*tx]);
    }
    curve.push(b); bridge.curve=curve;
  }
  return bridges;
}
