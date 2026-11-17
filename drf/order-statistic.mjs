// Partition finite measured values in place. Afterward every larger rank is on the right.
function select(values, rank, left, right) {
  while (left < right) {
    const middle = (left + right) >> 1;
    const a = values[left], b = values[middle], c = values[right];
    const pivot = a < b ? Math.max(a, Math.min(b, c)) : Math.max(b, Math.min(a, c));
    let i = left, j = right;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        const tmp = values[i]; values[i++] = values[j]; values[j--] = tmp;
      }
    }
    if (rank <= j) right = j;
    else if (rank >= i) left = i;
    else break;
  }
  return values[rank];
}

export function exactMedian(values) {
  const n = values.length, k = n >> 1;
  const upper = select(values, k, 0, n - 1);
  if (n % 2) return upper;
  let lower = values[0];
  for (let i = 1; i < k; i++) lower = Math.max(lower, values[i]);
  return (lower + upper) / 2;
}

// Keep the legacy linear interpolation order, including at the median.
export function exactQuantile(values, q, lo = 0) {
  const at = (values.length - 1) * q, k = Math.floor(at);
  const lower = select(values, k, lo, values.length - 1);
  if (at === k) return lower;
  let upper = values[k + 1];
  for (let i = k + 2; i < values.length; i++) upper = Math.min(upper, values[i]);
  return lower + (at - k) * (upper - lower);
}
