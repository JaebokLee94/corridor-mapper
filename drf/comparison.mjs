/** Both methods consume identical causal wire; the display field is independent.
 * Fixed exploratory tuning thresholds; never selected using the displayed scene.
 * Provenance and selection losses: THRESHOLD_PROTOCOL.md. No error certificate.
 */
import { completeWallGaps } from './bridge-curves.mjs?v=20261112-chain-tips';
import { GapRangeEvidence } from './bridge-evidence.mjs?v=20261112-chain-tips';
import { markCentreExtensions, checkedChainTips, confirmedExtensions, CHECKED_CENTRE_RULE } from './checked-centre.mjs?v=20261112-chain-tips';
import { centreSpline, CENTRE_RULE } from './centre-spline.mjs';
import { BRIDGE_RULE } from './wall-bridges.mjs?v=20261112-chain-tips';
import { PSPT } from './pspt.mjs';
import { Baseline } from './baseline.mjs?v=20261022-audit1';
const tuning = Object.freeze({
  id:'tuning-200-20261020', role:'development / exploratory tuning', scenes:200,
  seedRangeInclusive:Object.freeze([12000000,12000199]), vehicles:3, snapshots:120, sigmaP:0, sigmaD:0.1,
  selection:'maximum observed-wall recall among score breakpoints with mean grouped-fragment FP <= 0.01',
  certified:false, jointFpRecallTargetMet:false, source:'validation/threshold-tuning-20261020.json',
});
export const METHOD_PROTOCOL = Object.freeze({
  guarded: Object.freeze({ name:'WM-P', interpolation:BRIDGE_RULE, centreSpline:CENTRE_RULE, checkedCentre:CHECKED_CENTRE_RULE, threshold:6.650397183049193, previousDevThreshold:6.4615384615384635,
    score:'current four-hypothesis marginal log-odds', grid:Object.freeze([100,100]), calibrated:false, tuning,
    revision:'guarded45-shared-pose-bounded-clusters-20261104', refinement:'shared-pose', clustering:'bounded-span',
    thresholdStatus:'Inherited development threshold; not retuned or certified for this refinement and clustering revision.' }),
  baseline: Object.freeze({ name:'WM-F', interpolation:BRIDGE_RULE, centreSpline:CENTRE_RULE, checkedCentre:CHECKED_CENTRE_RULE, threshold:29.108623616301394, previousDevThreshold:12,
    score:'maximum qualified Gaussian log-score through the current snapshot', grid:Object.freeze([100,100]), calibrated:false, tuning }),
});
const logadd = (a,b) => Math.max(a,b)+Math.log1p(Math.exp(-Math.abs(a-b)));
export function selectGuarded(estimator,rows=estimator.report()) {
  const groups=new Map(estimator.groups.map(g=>[g.gid,g]));
  // Retired geometry is retained in the estimator's audit ledger, but is neither
  // an active rejection nor a selectable map fragment. Historical first-support
  // errors remain in the evaluator ledger even when a fragment is retired.
  return rows.filter(r => !r.retired).map(r=>{
    const g=groups.get(r.gid),k=r.side,selectionLogit=logadd(g.L[k+1],g.L[3])-logadd(g.L[0],g.L[2-k]);
    const eligible=g.nobs>0 && g.qualified_active[k]>=2 && g.qualified_matched[k]>=2;
    const status=eligible && selectionLogit>=METHOD_PROTOCOL.guarded.threshold ? 'supported' : r.status==='contradicted' ? 'contradicted' : 'pending';
    // The displayed decision uses the development log-score threshold, not the
    // reference estimator's 0.99 weight gate. Its explanation must use that gate.
    const reason=status==='supported' ? 'fixed log-score threshold and local evidence requirements passed'
      : status==='contradicted' ? r.reason
      : g.nobs===0 ? 'no predictive observation'
      : g.qualified_active[k]<2 ? 'pose geometry not distinguished from noise in two active snapshots'
      : g.qualified_matched[k]<2 ? 'fewer than two own-patch range matches'
      : 'current log-score below the fixed selection threshold';
    return {...r,selectionLogit,eligible,originalStatus:r.status,originalReason:r.reason,status,reason};
  });
}
export class MethodComparison {
  constructor(options={}) {
    this.includeExtended = options.includeExtended ?? false;
    this.guarded = new PSPT({refinement:METHOD_PROTOCOL.guarded.refinement,clustering:METHOD_PROTOCOL.guarded.clustering});
    this.baseline = new Baseline(options);
    this.gapEvidence = new GapRangeEvidence(this.baseline.sigmaR);
  }
  mapFrame(candidates,start) {
    const extendedBridges=this.includeExtended?[]:undefined, ambiguous=this.includeExtended?[]:undefined;
    const bridges=completeWallGaps(candidates,extendedBridges,this.gapEvidence,ambiguous);
    let checkedChains;
    if(extendedBridges) {
      markCentreExtensions(candidates,bridges,extendedBridges,this.gapEvidence);
      if(ambiguous.length) {
        const current=centreSpline(candidates,bridges,confirmedExtensions(bridges,extendedBridges));
        checkedChains=checkedChainTips(candidates,current,ambiguous,this.gapEvidence);
      }
    }
    return {candidates,bridges,extendedBridges,...(checkedChains?.length?{checkedChains}:{}),ms:performance.now()-start};
  }
  step(wire) {
    let start=performance.now();
    const candidates=selectGuarded(this.guarded,this.guarded.step(wire));
    this.gapEvidence.add(wire);
    const guarded=this.mapFrame(candidates,start);
    start=performance.now();
    const baseline=this.mapFrame(this.baseline.step(wire,METHOD_PROTOCOL.baseline.threshold),start);
    return {guarded,baseline};
  }
}
