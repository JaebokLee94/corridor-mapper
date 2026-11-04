/** Both methods consume identical causal wire; the display field is independent.
 * Fixed exploratory tuning thresholds; never selected using the displayed scene.
 * Provenance and selection losses: THRESHOLD_PROTOCOL.md. No error certificate.
 */
import { PSPT } from './pspt.mjs';
import { Baseline } from './baseline.mjs?v=20261022-audit1';
const tuning = Object.freeze({
  id:'tuning-200-20261020', role:'development / exploratory tuning', scenes:200,
  seedRangeInclusive:Object.freeze([12000000,12000199]), vehicles:3, snapshots:120, sigmaP:0, sigmaD:0.1,
  selection:'maximum observed-wall recall among score breakpoints with mean grouped-fragment FP <= 0.01',
  certified:false, jointFpRecallTargetMet:false, source:'validation/threshold-tuning-20261020.json',
});
export const METHOD_PROTOCOL = Object.freeze({
  guarded: Object.freeze({ name:'Guarded PSPT', threshold:6.650397183049193, previousDevThreshold:6.4615384615384635,
    score:'current four-hypothesis marginal log-odds', grid:Object.freeze([100,100]), calibrated:false, tuning }),
  baseline: Object.freeze({ name:'Fixed-fragment B', threshold:29.108623616301394, previousDevThreshold:12,
    score:'maximum qualified Gaussian log-score through the current snapshot', grid:Object.freeze([100,100]), calibrated:false, tuning }),
});
const logadd = (a,b) => Math.max(a,b)+Math.log1p(Math.exp(-Math.abs(a-b)));
export function selectGuarded(estimator,rows=estimator.report()) {
  const groups=new Map(estimator.groups.map(g=>[g.gid,g]));
  return rows.map(r=>{
    const g=groups.get(r.gid),k=r.side,selectionLogit=logadd(g.L[k+1],g.L[3])-logadd(g.L[0],g.L[2-k]);
    const eligible=g.nobs>0 && g.qualified_active[k]>=2 && g.qualified_matched[k]>=2;
    return {...r,selectionLogit,eligible,originalStatus:r.status,
      status:eligible && selectionLogit>=METHOD_PROTOCOL.guarded.threshold ? 'supported' : r.status==='contradicted' ? 'contradicted' : 'pending'};
  });
}
export class MethodComparison {
  constructor(options={}) {this.guarded=new PSPT();this.baseline=new Baseline(options);}
  step(wire) {
    let start=performance.now();const guarded=selectGuarded(this.guarded,this.guarded.step(wire)),guardedMs=performance.now()-start;
    start=performance.now();const baseline=this.baseline.step(wire,METHOD_PROTOCOL.baseline.threshold),baselineMs=performance.now()-start;
    return {guarded:{candidates:guarded,ms:guardedMs},baseline:{candidates:baseline,ms:baselineMs}};
  }
}
