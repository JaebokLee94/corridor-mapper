/** Selective Schmidt update of one quadratic patch.
 * Input: surface x[3]=[offset m, angle rad, curvature 1/m], P[3,3].
 * comps[M] use the existing PSPT tuple [config,count,sigma_r²,residual,prediction].
 * Prediction contains [range,u,H[3],ei[2],ej[2]]. No truth/seed/future input.
 * Preserve the original R=sigma_r²/count + shared-pose covariance and the
 * original update exactly unless the curvature innovation is inconsistent.
 * q=(K_k r)^2/(K_k S K_k') is nominal chi-square(1) under the linear Gaussian
 * prior-predictive model, S=H P H'+R. Selected cluster associations and nonlinear
 * roots violate that idealization; this is not a calibrated false-alarm bound.
 * On a rejected curvature component only, set gain row k to zero (Schmidt),
 * retain the other two gain rows, and propagate the full Joseph covariance.
 * O(M³), O(M²) scratch; the original pair-space solve still dominates.
 */
import {dot,matVec,matMul,transpose,solve} from './pspt-math.mjs';

// chi2.isf(.001, 1), fixed before development comparison; no seed-specific limit.
export const CURVATURE_INNOVATION_LIMIT=10.827566170662733;

export function curvatureConsistentUpdate(s,comps) {
  if (!comps.length) return {guarded:false,matches:0,reason:'no matches'};
  // Keep construction, solve and arithmetic ordering identical to legacy _kf.
  const M=comps.length,A=comps.map(cm=>cm[4][2]),residual=comps.map(cm=>cm[3]),
    R=Array.from({length:M},(_,i)=>Array.from({length:M},(_,j)=>i===j?comps[i][2]/comps[i][1]:0));
  for(let a=0;a<M;a++)for(let b=0;b<M;b++) {
    const [ca,,,,pa]=comps[a],[cb,,,,pb]=comps[b];
    for(const [va,ea,covariance] of [[ca.i,pa[3],ca.Si],[ca.j,pa[4],ca.Sj]])
      for(const [vb,eb] of [[cb.i,pb[3]],[cb.j,pb[4]]])
        if(va===vb)R[a][b]+=dot(ea,matVec(covariance,eb));
  }
  const AP=matMul(A,s.P),S=matMul(AP,transpose(A)).map((row,i)=>row.map((v,j)=>v+R[i][j])),
    gain=transpose(solve(S,AP)),delta=matVec(gain,residual),KA=matMul(gain,A),
    variance=dot(gain[2],matVec(S,gain[2]));
  if(!Number.isFinite(variance)||variance<0)throw new RangeError('invalid curvature innovation variance');
  const statistic=variance>0?delta[2]**2/variance:delta[2]===0?0:Infinity,
    guarded=delta[2]**2>CURVATURE_INNOVATION_LIMIT*variance;
  if(!guarded) {
    s.x=s.x.map((value,i)=>value+delta[i]);
    s.P=matMul(KA.map((row,i)=>row.map((value,j)=>Number(i===j)-value)),s.P);
  } else {
    // The frozen component keeps its old mean and marginal variance. Updating
    // cross-covariances is essential; merely resetting x[2] after a full update
    // would incorrectly claim information and break this constrained estimator.
    const activeGain=gain.map((row,i)=>i===2?row.map(()=>0):row.slice()),
      activeKA=KA.map((row,i)=>i===2?row.map(()=>0):row.slice()),
      B=activeKA.map((row,i)=>row.map((value,j)=>Number(i===j)-value)),
      state=s.x.map((value,i)=>i===2?value:value+delta[i]),
      propagated=matMul(matMul(B,s.P),transpose(B)),
      noise=matMul(matMul(activeGain,R),transpose(activeGain)),
      covariance=propagated.map((row,i)=>row.map((value,j)=>value+noise[i][j]));
    s.x=state;s.P=covariance.map((row,i)=>row.map((value,j)=>(value+covariance[j][i])/2));
  }
  if(![...s.x,...s.P.flat()].every(Number.isFinite))throw new RangeError('nonfinite curvature-consistent state');
  return {guarded,matches:M,statistic,limit:CURVATURE_INNOVATION_LIMIT,
    proposedCurvatureChange:delta[2],curvatureInnovationVariance:variance};
}
