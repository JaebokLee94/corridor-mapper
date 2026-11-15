import { rightMethods } from './right-methods.mjs?v=20261115-four-methods';
import { modelData, neuralRuntime } from './model-runtime.mjs';
import { correctFit } from './echospline-gbdt.mjs';
import { GatGpr } from './gat-gpr.mjs';
import { EchoArcCNN } from './echoarc-cnn.mjs';
import { EchoSpline } from './echospline.mjs?v=20261115-four-methods';
import { GapRangeEvidence } from './bridge-evidence.mjs?v=20261112-chain-tips';
import { PSPT, prepareMeasuredSnapshot } from './pspt.mjs?v=20261112-upper-wmp';
import { protocolForFleet, selectGuarded, wmpFrame } from './comparison.mjs?v=20261112-upper-wmp';

const paperSettings = new Map([
  [3, {threshold:6, parameters:{K:8, ext:1.1}}],
  [10, {threshold:6.5, parameters:{frac:.08, sep:1, dup:.7}}],
]);

export function echoProtocol(input={}) {
  if(input.rightMethod!=null&&!Object.hasOwn(rightMethods,input.rightMethod))throw new RangeError('Unknown right-hand comparison method');
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
    guarded:!input.rightMethod || input.rightMethod==='wmp' ? guarded
      : {...rightMethods[input.rightMethod],id:input.rightMethod,threshold:input.rightMethod==='arc'?0.7:null,
        training:'Frozen three-vehicle upper-wall checkpoint',revision:'20261115'}};
}

export class EchoComparison {
  constructor(input,domain) {
    this.protocol=echoProtocol(input);
    this.id=input.rightMethod??'wmp'; this.vehicles=input.vehicles; this.lastT=0;
    const bounds=input.scene==='paper-upper'?domain:undefined;
    const splineOptions={domain,upper:input.scene==='paper-upper',spacing:input.echoKnotM,support:input.echoSupportM};
    this.spline=new EchoSpline(splineOptions);
    if(this.id==='gbdt')this.fixedSpline=(input.echoKnotM??2)===2 && (input.echoSupportM??8)===8
      ? this.spline : new EchoSpline({...splineOptions,spacing:2,support:8});
    if(this.id==='wmp'){
      const {parameters,refinement,clustering}=this.protocol.guarded;
      this.wmp=new PSPT({refinement,clustering,domain:bounds,...parameters});
      this.evidence=new GapRangeEvidence(input.sigmaD);
    }
  }
  async loadModel(){
    if(this.id==='gbdt')this.tree=await modelData('gbdt');
    else if(this.id==='gat')this.model=new GatGpr(await neuralRuntime('gat'),this.vehicles);
    else if(this.id==='arc')this.model=new EchoArcCNN(await neuralRuntime('arc'));
  }
  step(wire) {
    const start=performance.now();let guarded;
    if(this.wmp){
      const cut=this.protocol.guarded.threshold;
      const rows=selectGuarded(this.wmp,this.wmp.step(wire),cut);
      this.evidence.add(wire);guarded=wmpFrame(rows,start,true,this.evidence);
    }else{
      if(wire.t!==this.lastT+1)throw new RangeError('Snapshots must be consecutive from t=1');
      prepareMeasuredSnapshot(wire);
      if(this.model)guarded={...this.model.step(wire),ms:performance.now()-start};
    }
    const fitStart=performance.now(),left=this.spline.step(wire,this.fixedSpline===this.spline),leftMs=performance.now()-fitStart;
    if(this.id==='gbdt'){
      const t=performance.now(),f=this.fixedSpline===this.spline?left:this.fixedSpline.step(wire,true);
      guarded={curves:f.fit?correctFit(f.fit,this.tree,wire.configs.length,8):[],candidates:[],ms:performance.now()-t};
    }
    if(this.fixedSpline===this.spline)delete left.fit;
    this.lastT=wire.t;
    return {echoSpline:{...left,candidates:[],ms:leftMs},guarded};
  }
}
