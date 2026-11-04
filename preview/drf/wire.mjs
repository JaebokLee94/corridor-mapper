/** Copy only the measured fields allowed across the estimator boundary. */
function vector(value, length, name) {
  if (!(Array.isArray(value) || ArrayBuffer.isView(value)) || value.length !== length)
    throw new TypeError(`${name} must have ${length} entries`);
  const out = Array.from(value);
  if (!out.every(Number.isFinite)) throw new RangeError(`${name} must be finite`);
  return out;
}
function covariance(value, name) {
  const out = vector(value, 3, name), [xx, xy, yy] = out;
  if (xx < 0 || yy < 0 || xy * xy > xx * yy)
    throw new RangeError(`${name} must be positive semidefinite`);
  return out;
}
export function makeWire(snapshot) {
  const t = snapshot.t;
  if (!Number.isSafeInteger(t) || t < 1 || !Array.isArray(snapshot.configs))
    throw new RangeError("snapshot requires an integer t >= 1 and configs");
  return {
    t,
    configs: snapshot.configs.map((config) => {
      const i = config.i, j = config.j;
      if (!Number.isSafeInteger(i) || !Number.isSafeInteger(j) || i < 0 || j < 0 || i === j)
        throw new RangeError("configuration requires distinct nonnegative vehicle indices");
      if (!Array.isArray(config.paths)) throw new TypeError("configuration paths must be an array");
      return {
        i, j,
        pHat_i: vector(config.pHat_i, 2, "pHat_i"),
        pHat_j: vector(config.pHat_j, 2, "pHat_j"),
        Sigma_i: covariance(config.Sigma_i, "Sigma_i"),
        Sigma_j: covariance(config.Sigma_j, "Sigma_j"),
        paths: config.paths.map((path) => {
          const dHat = path.dHat, sigmaD = path.sigmaD;
          if (!Number.isFinite(dHat) || !Number.isFinite(sigmaD) || sigmaD < 0)
            throw new RangeError("path requires finite dHat and nonnegative sigmaD");
          return { dHat, sigmaD };
        }),
      };
    }),
  };
}
