/** Finite or nonfinite empirical quantiles; empty samples remain undefined. */
export const percentile = (values, p) => {
  if (!values.length) return null;
  const a = values.slice().sort((x, y) => x - y);
  return a[Math.max(0, Math.min(a.length - 1, Math.ceil(p * a.length) - 1))];
};
export const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
