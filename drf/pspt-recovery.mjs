/** Measured-state-only, one-replacement lifecycle for rejected surface hypotheses.
 * No scene, seed, truth, or future input. Distances are metres. A retired side
 * remains in its four-hypothesis group for audit; its live mirror is preserved.
 * Scanning G groups costs O(G), with at most O(G) persistent tombstones.
 */
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function recoveryNeighbors(groups, point, radius) {
  return groups.flatMap(g => g.s.map((s, side) => ({ g, side, center: s.center })))
    .filter(e => !e.g.retired?.[e.side] && distance(point, e.center) < radius);
}

export function planRecovery(groups, tombstones, point, radius, recoveryRadius = radius) {
  // A fixed replacement anchor prevents a displaced child from opening an
  // unlimited sequence of fresh trials at its ancestor's location.
  if (tombstones.some(p => distance(point, p.center) < recoveryRadius)) return { blocked: true, parents: [] };
  // Post-fit NMS uses a smaller radius than recovery. A replacement that moved
  // away from its ancestor must still consume its full local retry budget.
  const recoveryNeighborhood = recoveryNeighbors(groups, point, recoveryRadius);
  if (recoveryNeighborhood.some(({ g, side }) => (g.recoveryAttempts?.[side] ?? 0) >= 1))
    return { blocked: true, parents: [] };
  const neighbors = recoveryNeighbors(groups, point, radius);
  const blocked = neighbors.some(({ g, side }) => g.status[side] !== 'contradicted');
  // A fitted proposal inside the retry neighborhood must inherit its rejected
  // parents even when it lies outside the smaller geometric NMS radius.
  return { blocked, parents: blocked ? [] : recoveryNeighborhood.filter(({ g, side }) => g.status[side] === 'contradicted') };
}

export function initializeRecovery(group) {
  group.retired = [null, null];
  group.recoveryAttempts = [0, 0];
  group.replaces = [[], []];
}

export function commitRecovery(groups, tombstones, child, parents, t, recoveryRadius = 1) {
  initializeRecovery(child);
  const unique = [...new Map(parents.map(e => [e.g.gid + ':' + e.side, e])).values()];
  if (unique.length) {
    child.recoveryAttempts = [1, 1];
    child.replaces[0] = unique.map(e => e.g.gid + 'hc'[e.side]);
    for (const { g, side } of unique) {
      const center = g.s[side].center.slice();
      g.retired[side] = { t, replacement: child.gid + 'h', reason: 'replaced rejected geometry',
        center, state: g.s[side].x.slice(), covariance: g.s[side].P.map(r => r.slice()),
        scoreAtRetirement: g.r[side], logWeightsAtRetirement: g.L.slice() };
      g.status[side] = 'contradicted';
      g.reason[side] = 'retired: replaced rejected geometry';
      tombstones.push({ center, parent: g.gid + 'hc'[side], replacement: child.gid + 'h' });
    }
  }
  // A new counterpart must not duplicate an already-live surface. Disable only
  // the new side, leaving the previous group's evidence and geometry untouched.
  const mirrorPoint = child.s[1].center,
    tombstone = tombstones.find(p => distance(mirrorPoint, p.center) < recoveryRadius),
    duplicate = recoveryNeighbors(groups, mirrorPoint, recoveryRadius)[0];
  // Only an independently observed DRF ridge may start a replacement. A
  // mirrored copy must not reopen a consumed or rejected neighborhood.
  if (tombstone || duplicate) child.retired[1] = { t,
    replacement: tombstone?.replacement ?? duplicate.g.gid + 'hc'[duplicate.side],
    reason: tombstone ? 'recovery neighborhood already used' : 'duplicate existing counterpart', center: mirrorPoint.slice(),
    state: child.s[1].x.slice(), covariance: child.s[1].P.map(r => r.slice()),
    scoreAtRetirement: 0.5, logWeightsAtRetirement: [0, 0, 0, 0] };
}
