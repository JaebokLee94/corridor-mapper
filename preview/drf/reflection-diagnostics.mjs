/** Post-hoc scattering diagnostics, independent of field peaks and corridor axes.
 * Input: generated reflection records through t. No estimator reads this module.
 * Work per new configuration O(D*S) for D diffuse and S specular points,
 * plus O(R log R) per report for R accumulated ratios; memory O(past reflections).
 */
import { mean, percentile } from './statistics.mjs';
export function createReflectionDiagnostics(scenario) {
  const wallId = q => q.wall ?? scenario.spans?.find(span => span.span === q.span)?.wall;
  const ratios = [], counts = [], predictedCounts = [], folds = [], duplicateFlags = [];
  let cursor = 0, specularCount = 0, diffuseCount = 0, degenerate = 0, unlabelled = 0;
  return { step(t) {
    if (!Number.isInteger(t) || t < cursor || t > scenario.truth.length) throw new Error('Diagnostics require causal, monotone snapshots');
    while (cursor < t) {
      for (const config of scenario.truth[cursor++].configs) {
        const spec = config.specular, diff = config.diffuse;
        specularCount += spec.length; diffuseCount += diff.length; counts.push(diff.length);
        let countPrediction = 0;
        for (const q of spec) {
          if (scenario.input.roughness > 0 && Math.abs(q.dkap) > 1e-9) countPrediction += scenario.input.lambda0 * Math.sqrt(2 * Math.PI) * scenario.input.roughness * Math.PI / 180 / Math.abs(q.dkap);
          const sigmaR = Math.sqrt(scenario.input.sigmaD ** 2 + 2 * scenario.input.sigmaP ** 2);
          if (q.cth > 1e-9) folds.push(0.765 * Math.SQRT2 * sigmaR / (2 * q.cth));
        }
        predictedCounts.push(countPrediction);
        for (const q of diff) {
          duplicateFlags.push(spec.some(s => Math.abs(s.rho - q.rho) <= scenario.input.sigmaD) ? 1 : 0);
          const wall = wallId(q);
          if (wall == null) { unlabelled++; continue; }
          const sameWall = spec.filter(s => wallId(s) === wall);
          const nearest = sameWall.reduce((best, s) => !best || Math.hypot(s.s[0] - q.s[0], s.s[1] - q.s[1]) < Math.hypot(best.s[0] - q.s[0], best.s[1] - q.s[1]) ? s : best, null);
          if (!nearest) continue;
          if (Math.abs(nearest.dkap) <= 1e-9 || scenario.input.roughness === 0) { degenerate++; continue; }
          const sigma = scenario.input.roughness * Math.PI / 180;
          if (Math.abs(q.s[0] - nearest.s[0]) <= 4 * sigma / Math.abs(nearest.dkap)) {
            const varsigma = nearest.cth * sigma ** 2 / nearest.dkap;
            if (Math.abs(varsigma) > 1e-15) ratios.push((q.rho - nearest.rho) / varsigma);
          }
        }
      }
    }
    return { specularCount, diffuseCount, configurationCount: counts.length,
      diffusePerConfig: mean(counts), duplicateFraction: mean(duplicateFlags),
      theoremMean: mean(ratios), theoremMedian: percentile(ratios, .5), theoremNegative: ratios.filter(x => x < 0).length,
      ratios: ratios.slice(), diffuseCounts: counts.slice(), predictedCounts: predictedCounts.slice(),
      foldPrediction: mean(folds), degenerate, unlabelled,
      role: 'post-hoc reflection diagnostics; no field-peak wall classification' };
  } };
}
