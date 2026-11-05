/** One successful measured-field increment, shared only by explicit consumers.
 * Inputs contain current measured wire, exact grid coordinates and numerical
 * settings. No estimator state, truth, labels or future frames are cached.
 * At most O(G + P) storage for G grid cells and P paths in one snapshot.
 */
const caches = new WeakMap();

export function createFieldUpdateCache() {
  const token = Object.freeze({});
  caches.set(token, null);
  return token;
}

export function validateFieldUpdateCache(token) {
  if (token !== null && !caches.has(token)) throw new TypeError('Invalid measured-field update cache');
}

function sameArray(a, b) {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

function sameWire(a, b) {
  if (a.t !== b.t || a.configs.length !== b.configs.length) return false;
  for (let i = 0; i < a.configs.length; i++) {
    const left = a.configs[i], right = b.configs[i];
    if (left.i !== right.i || left.j !== right.j || left.paths.length !== right.paths.length
        || !sameArray(left.pHat_i, right.pHat_i) || !sameArray(left.pHat_j, right.pHat_j)
        || !sameArray(left.Sigma_i, right.Sigma_i) || !sameArray(left.Sigma_j, right.Sigma_j)) return false;
    for (let j = 0; j < left.paths.length; j++) {
      if (!Object.is(left.paths[j].dHat, right.paths[j].dHat)
          || !Object.is(left.paths[j].sigmaD, right.paths[j].sigmaD)) return false;
    }
  }
  return true;
}

export function findFieldIncrement(token, wire, grid, band, perimeter) {
  const entry = token === null ? null : caches.get(token);
  if (!entry || entry.band !== band || entry.perimeter !== perimeter
      || grid.nx !== entry.nx || grid.ny !== entry.ny
      || !sameArray(grid.x, entry.x) || !sameArray(grid.y, entry.y)
      || !sameWire(wire, entry.wire)) return null;
  return entry;
}

export function saveFieldIncrement(token, wire, grid, band, perimeter, deltaD, deltaA, admitted, rejected) {
  if (token === null) return;
  // makeWire already created private measured arrays. Copy scratch increments
  // because each consumer will reuse its own scratch buffers on the next step.
  caches.set(token, { wire, nx:grid.nx, ny:grid.ny, x:grid.x.slice(), y:grid.y.slice(),
    band, perimeter, deltaD:deltaD.slice(), deltaA:deltaA.slice(), admitted, rejected });
}
