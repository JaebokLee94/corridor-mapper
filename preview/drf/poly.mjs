/** Ascending power coefficients; degree <= 9 in the simulator. */
export function evaluatePolynomial(a, x) {
  let value = 0;
  for (let i = a.length - 1; i >= 0; i--) value = value * x + a[i];
  return value;
}
export function derivative(a) { return a.slice(1).map((value, i) => value * (i + 1)); }
export function multiply(a, b) {
  const out = Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
}
export function add(a, b, sign = 1) {
  return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] || 0) + sign * (b[i] || 0));
}
function choose(n, k) {
  let out = 1;
  for (let i = 1; i <= k; i++) out *= (n - i + 1) / i;
  return out;
}
export function powerToBernstein(a) {
  const n = a.length - 1;
  return a.map((_, k) => {
    let sum = 0;
    for (let i = 0; i <= k; i++) sum += a[i] * choose(k, i) / choose(n, i);
    return sum;
  });
}
export function subdivideBernstein(b) {
  const work = b.slice(), left = [work[0]], right = [work.at(-1)];
  for (let n = b.length - 1; n > 0; n--) {
    for (let i = 0; i < n; i++) work[i] = (work[i] + work[i + 1]) / 2;
    left.push(work[0]); right.push(work[n - 1]);
  }
  return [left, right.reverse()];
}
function variations(b) {
  let previous = 0, count = 0;
  for (const value of b) if (value !== 0) {
    const sign = Math.sign(value);
    if (previous && previous !== sign) count++;
    previous = sign;
  }
  return count;
}
function polish(a, lo, hi) {
  const da = derivative(a);
  let flo = evaluatePolynomial(a, lo), fhi = evaluatePolynomial(a, hi);
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  let x = (lo + hi) / 2;
  for (let iteration = 0; iteration < 90; iteration++) {
    const fx = evaluatePolynomial(a, x);
    if (fx === 0) return x;
    if (Math.sign(fx) === Math.sign(flo)) { lo = x; flo = fx; } else { hi = x; fhi = fx; }
    if (hi - lo <= 1e-15) break;
    const candidate = x - fx / evaluatePolynomial(da, x);
    x = candidate > lo && candidate < hi ? candidate : (lo + hi) / 2;
  }
  return Math.abs(flo) < Math.abs(fhi) ? lo : hi;
}
/** Bernstein subdivision isolates simple roots. Derivative stationary points
 * recover even-multiplicity roots. Unresolved/degenerate cases are reported,
 * never represented as a universal Float64 accuracy guarantee. */
export function rootInfo(coefficients) {
  let a = coefficients.slice();
  if (!a.every(Number.isFinite)) throw new TypeError('Polynomial coefficients must be finite');
  while (a.length > 1 && a.at(-1) === 0) a.pop();
  const scale = Math.max(0, ...a.map(Math.abs));
  if (!scale) return { roots: [], degenerate: true, unresolved: 0 };
  a = a.map(value => value / scale);
  if (a.length === 1) return { roots: [], degenerate: false, unresolved: 0 };
  const found = [], bernstein = powerToBernstein(a);
  let unresolved = 0, nearMultiple = 0;
  const accept = x => { if (x >= 0 && x <= 1) found.push(x); };
  const descend = (b, lo, hi, depth) => {
    if (b[0] === 0) accept(lo);
    if (b.at(-1) === 0) accept(hi);
    const count = variations(b);
    if (!count) return;
    if (count === 1) {
      const flo = evaluatePolynomial(a, lo), fhi = evaluatePolynomial(a, hi);
      if (flo * fhi <= 0) { accept(polish(a, lo, hi)); return; }
    }
    if (depth >= 52 || hi - lo <= 1e-15) { unresolved++; return; }
    const [left, right] = subdivideBernstein(b), mid = (lo + hi) / 2;
    descend(left, lo, mid, depth + 1); descend(right, mid, hi, depth + 1);
  };
  descend(bernstein, 0, 1, 0);
  if (variations(bernstein) > 1 && a.length > 2) {
    const critical = rootInfo(derivative(a)).roots;
    for (const x of critical) {
      const roundoff = 32 * Number.EPSILON * a.reduce((sum, value, i) => sum + Math.abs(value) * x ** i, 0);
      if (Math.abs(evaluatePolynomial(a, x)) <= roundoff) {
        // A repeated root can split by O(sqrt(eps)) after coefficient rounding.
        // Collapse only its condition-based uncertainty neighborhood and report it.
        let derived = derivative(a), factorial = 1, radius = 2e-12;
        for (let order = 2; order < a.length; order++) {
          derived = derivative(derived); factorial *= order;
          const leading = Math.abs(evaluatePolynomial(derived, x)) / factorial;
          if (leading > 64 * Number.EPSILON) { radius = 4 * (roundoff / leading) ** (1 / order); break; }
        }
        for (let i = found.length - 1; i >= 0; i--) if (Math.abs(found[i] - x) <= radius) found.splice(i, 1);
        accept(x); nearMultiple++;
      }
    }
  }
  found.sort((x, y) => x - y);
  const roots = found.filter((x, i) => !i || Math.abs(x - found[i - 1]) > 2e-12);
  return { roots, degenerate: false, unresolved, nearMultiple };
}
export function realRoots(coefficients) { return rootInfo(coefficients).roots; }
