/** Deterministic xoshiro128** streams. All uniforms lie strictly in (0,1). */
export function createRng(seed, ...parts) {
  let hash = 2166136261;
  for (const ch of JSON.stringify([seed, ...parts])) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  const state = Array.from({ length: 4 }, () => {
    hash = (hash + 0x9e3779b9) >>> 0;
    let z = hash;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  });
  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
  let spare;
  function uniform() {
    const output = Math.imul(rotl(Math.imul(state[1], 5), 7), 9) >>> 0;
    const t = state[1] << 9;
    state[2] ^= state[0]; state[3] ^= state[1]; state[1] ^= state[2]; state[0] ^= state[3];
    state[2] ^= t; state[3] = rotl(state[3], 11);
    return (output + 0.5) / 4294967296;
  }
  function normal() {
    if (spare !== undefined) { const value = spare; spare = undefined; return value; }
    const radius = Math.sqrt(-2 * Math.log(uniform()));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }
  function poisson(mean) {
    if (!(Number.isFinite(mean) && mean >= 0)) throw new RangeError('Poisson mean must be finite and nonnegative');
    let count = 0;
    // Independent Poisson variables add: each Knuth product has mean <= 30.
    for (let remaining = mean; remaining > 0;) {
      const chunk = Math.min(30, remaining), limit = Math.exp(-chunk);
      let product = 1, n = 0;
      do { n++; product *= uniform(); } while (product > limit);
      count += n - 1; remaining -= chunk;
    }
    return count;
  }
  return { uniform, normal, poisson };
}
