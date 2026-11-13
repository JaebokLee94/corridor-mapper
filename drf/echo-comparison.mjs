import { EchoSpline } from './echospline.mjs';
import { GapRangeEvidence } from './bridge-evidence.mjs?v=20261112-chain-tips';
import { PSPT } from './pspt.mjs?v=20261112-upper-wmp';
import { protocolForFleet, selectGuarded, wmpFrame } from './comparison.mjs?v=20261112-upper-wmp';

export function echoProtocol(input={}) {
  const spacing=input.echoKnotM??2,support=input.echoSupportM??8;
  return {echoSpline:{name:'EchoSpline',revision:'multi-echo-bspline-1',threshold:null,
    parameters:{knotSpacingM:spacing,supportDistanceM:support,rangeGateM:1.5,regularization:.2},
    wallHypothesis:input.scene==='paper-upper'?'upper':'select one side by range residual',
    score:'robust one-to-one multi-echo range fit',tuning:{id:'single-wall-multiecho',certified:false}},
    guarded:protocolForFleet(input.vehicles).guarded};
}

export class EchoComparison {
  constructor(input,domain) {
    this.protocol=echoProtocol(input);
    const {parameters,refinement,clustering}=this.protocol.guarded;
    this.wmp=new PSPT({refinement,clustering,domain:input.scene==='paper-upper'?domain:undefined,...parameters});
    this.evidence=new GapRangeEvidence(input.sigmaD);
    this.spline=new EchoSpline({domain,upper:input.scene==='paper-upper',spacing:input.echoKnotM,support:input.echoSupportM});
  }
  step(wire) {
    const start=performance.now();
    // WM-P validates the full measurement packet before either estimator changes state.
    const rows=selectGuarded(this.wmp,this.wmp.step(wire),this.protocol.guarded.threshold);
    this.evidence.add(wire);
    const guarded=wmpFrame(rows,start,true,this.evidence);
    const fitStart=performance.now(),curve=this.spline.step(wire);
    return {echoSpline:{...curve,candidates:[],ms:performance.now()-fitStart},guarded};
  }
}
