import { normalizeInput, createSceneGeometry, truePoses } from './scenario.mjs?v=20261112-upper-wmp';
import { diffuseProfile } from './diffuse.mjs';

/** Reconstruct one completed sweep experiment's final-snapshot truth profile.
 * Input: the saved run.input, including its seed and snapshot count.
 * Output: { domain: [xmin,xmax,ymin,ymax], t, configs: [{i,j}], profile(index) }.
 * Vehicle IDs are 1-based; config indices are 0-based, matching generateSnapshot.
 * This is post-hoc display data, never estimator input. No measurements or
 * estimator history are regenerated. Geometry generation uses the simulator's
 * existing deterministic validation; each pair profile costs O(W) for W wall
 * cells. Retain only this experiment's geometry/poses and its last pair profile,
 * rather than O(V^2 W) profiles or O(T V^2) reflection histories.
 */
export function createSweepProfileSource(raw) {
  const input = normalizeInput(raw), { spans, wallModel, domain } = createSceneGeometry(input),
    t = input.snapshots, positions = truePoses(t, input.vehicles, wallModel), configs = [];
  for (let i = 1; i <= input.vehicles; i++) for (let j = i + 1; j <= input.vehicles; j++) configs.push({ i, j });
  let cachedIndex = -1, cachedProfile;
  return {
    domain, t, configs,
    profile(configIndex) {
      if (!Number.isInteger(configIndex) || configIndex < 0 || configIndex >= configs.length)
        throw new RangeError('Select a valid vehicle pair for this sweep experiment');
      if (configIndex !== cachedIndex) {
        const { i, j } = configs[configIndex];
        cachedProfile = diffuseProfile(spans, positions[i - 1], positions[j - 1],
          input.roughness * Math.PI / 180, input.lambda0, input.cellStep);
        cachedIndex = configIndex;
      }
      return cachedProfile;
    },
  };
}
