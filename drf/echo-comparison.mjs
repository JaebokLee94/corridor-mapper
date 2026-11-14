import { EchoSpline } from './echospline.mjs';
import { GapRangeEvidence } from './bridge-evidence.mjs?v=20261112-chain-tips';
import { PSPT } from './pspt.mjs?v=20261112-upper-wmp';
import { protocolForFleet, selectGuarded, wmpFrame } from './comparison.mjs?v=20261112-upper-wmp';

const paperSettings = new Map([
  [3, {threshold:6, parameters:{K:8, ext:1.1}}],
  [10, {threshold:6.5, parameters:{frac:.08, sep:1, dup:.7}}],
]);

export function echoProtocol(input={}) {
  const spacing=input.echoKnotM??2,support=input.echoSupportM??8;
  const previous=protocolForFleet(input.vehicles).guarded;
  const selected=input.scene==='paper-upper' && paperSettings.get(input.vehicles);
  const guarded=selected ? {...previous, threshold:selected.threshold, previousDevThreshold:previous.threshold,
    parameters:{...previous.parameters,...selected.parameters}, revision:'wm-p-paper-upper-20261114',
    thresholdStatus:'Fixed on separate straight-route upper-wall development seeds.',
    tuning:{...previous.tuning,id:`wmp-paper-upper-${input.vehicles}v-20261114`,screeningScenes:16,scenes:96,testScenes:512,
      sigmaDGeometry:[.33,3],scene:'paper-upper',selection:'Maximum mean final raw Map F1 at 0.4 m across both roughness heights'}} : previous;
  return {echoSpline:{name:'EchoSpline',revision:'multi-echo-bspline-1',threshold:null,
    parameters:{knotSpacingM:spacing,supportDistanceM:support,rangeGateM:1.5,regularization:.2},
    wallHypothesis:input.scene==='paper-upper'?'upper':'select one side by range residual',
    score:'robust one-to-one multi-echo range fit',tuning:{id:'single-wall-multiecho',certified:false}},
    guarded};
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
