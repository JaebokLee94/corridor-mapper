/** Both methods consume identical causal wire; the display field is independent.
 * Fixed exploratory tuning thresholds; never selected using the displayed scene.
 * Provenance and selection losses: THRESHOLD_PROTOCOL.md. No error certificate.
 */
import { completeWallGaps } from './bridge-curves.mjs?v=20261112-chain-tips';
import { GapRangeEvidence } from './bridge-evidence.mjs?v=20261112-chain-tips';
import { markCentreExtensions, checkedChainTips, confirmedExtensions, CHECKED_CENTRE_RULE } from './checked-centre.mjs?v=20261112-chain-tips';
import { centreSpline, CENTRE_RULE } from './centre-spline.mjs';
import { BRIDGE_RULE } from './wall-bridges.mjs?v=20261112-chain-tips';
import { PSPT } from './pspt.mjs?v=20261112-upper-wmp';
import { Baseline } from './baseline.mjs?v=20261112-upper-wmp';
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
function upperWallGuarded(vehicles, ell, p_miss, threshold) {
  return Object.freeze({...METHOD_PROTOCOL.guarded, threshold, previousDevThreshold:METHOD_PROTOCOL.guarded.threshold,
    parameters:Object.freeze({ell, p_miss, max_range:45}), revision:'wm-p-upper-fleet-20261112',
    thresholdStatus:'Selected for un-interpolated Map F1 on 100-snapshot upper-wall scenes.',
    tuning:Object.freeze({id:`wmp-upper-${vehicles}v-20261112`, vehicles, role:'development',
      screeningScenes:40, scenes:60, testScenes:100, snapshots:100, sigmaP:0, sigmaD:0.4,
      wallSide:'upper', selection:'Maximum mean final raw Map F1 at 0.4 m', certified:false,
      source:'THRESHOLD_PROTOCOL.md'})});
}
const tenVehicleProtocol = Object.freeze({guarded:upperWallGuarded(10,1.25,0.25,4.5), baseline:METHOD_PROTOCOL.baseline});
const threeVehicleProtocol = Object.freeze({
  guarded: upperWallGuarded(3,4,0.05,10.754131418601359),
  baseline: Object.freeze({...METHOD_PROTOCOL.baseline, threshold:28, previousDevThreshold:METHOD_PROTOCOL.baseline.threshold,
    thresholdStatus:'WM-F uses the operating point selected on 120 three-vehicle opening and fork scenes.',
    tuning:Object.freeze({id:'wmf-topology-3v-20261112', role:'development', vehicles:3,
      scenes:120, snapshots:120, sigmaP:.1, sigmaD:.1, certified:false,
      selection:'Highest mean final Map F1 with no increase in closed openings or wrong branch connections.',
      source:'THRESHOLD_PROTOCOL.md'}),
  }),
});
export const protocolForFleet = vehicles => vehicles === 3 ? threeVehicleProtocol : vehicles === 10 ? tenVehicleProtocol : METHOD_PROTOCOL;

const logadd = (a,b) => Math.max(a,b)+Math.log1p(Math.exp(-Math.abs(a-b)));
export function selectGuarded(estimator,rows=estimator.report(),threshold=METHOD_PROTOCOL.guarded.threshold) {
  const groups=new Map(estimator.groups.map(g=>[g.gid,g]));
  // Retired geometry is retained in the estimator's audit ledger, but is neither
  // an active rejection nor a selectable map fragment. Historical first-support
  // errors remain in the evaluator ledger even when a fragment is retired.
  return rows.filter(r => !r.retired).map(r=>{
    const g=groups.get(r.gid),k=r.side,selectionLogit=logadd(g.L[k+1],g.L[3])-logadd(g.L[0],g.L[2-k]);
    const eligible=g.nobs>0 && g.qualified_active[k]>=2 && g.qualified_matched[k]>=2;
    const status=eligible && selectionLogit>=threshold ? 'supported' : r.status==='contradicted' ? 'contradicted' : 'pending';
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
    this.protocol = options.vehicles == null ? null : protocolForFleet(options.vehicles);
    this.includeExtended = options.includeExtended ?? false;
    this.domain = options.domain;
    this.guarded = this.protocol ? this.createGuarded() : null;
    this.baseline = new Baseline({...options, domain:this.domain});
    this.gapEvidence = new GapRangeEvidence(this.baseline.sigmaR);
  }
  createGuarded() {
    const {refinement,clustering,parameters} = this.protocol.guarded;
    return new PSPT({refinement,clustering,domain:this.domain,...parameters});
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
    // Older clients supply fleet size through measured pair IDs on their first frame.
    this.protocol ??= protocolForFleet(new Set(wire.configs.flatMap(l=>[l.i,l.j])).size);
    this.guarded ??= this.createGuarded();
    const candidates=selectGuarded(this.guarded,this.guarded.step(wire),this.protocol.guarded.threshold);
    this.gapEvidence.add(wire);
    const guarded=this.mapFrame(candidates,start);
    start=performance.now();
    const baseline=this.mapFrame(this.baseline.step(wire,this.protocol.baseline.threshold),start);
    return {guarded,baseline};
  }
}
