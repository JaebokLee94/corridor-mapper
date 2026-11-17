import { rightMethods } from './right-methods.mjs?v=20261115-four-methods';
import { modelData, neuralRuntime } from './model-runtime.mjs';
import { correctFit } from './echospline-gbdt.mjs';
import { GatGpr } from './gat-gpr.mjs';
import { EchoArcCNN } from './echoarc-cnn.mjs?v=20261117-arc-resident';
import { EchoSpline } from './echospline.mjs?v=20261115-four-methods';
import { GapRangeEvidence } from './bridge-evidence.mjs?v=20261112-chain-tips';
import { PSPT, validateMeasuredSnapshot } from './pspt.mjs?v=20261112-upper-wmp';
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
  constructor(input,domain,side,stationaryCandidates) {
    this.protocol=echoProtocol(input);
    this.id=input.rightMethod??'wmp'; this.vehicles=input.vehicles; this.lastT=0;this.leftT=0;
    const bounds=input.scene==='paper-upper'?domain:undefined;
    const splineOptions={domain,upper:input.scene==='paper-upper',spacing:input.echoKnotM,support:input.echoSupportM,stationaryCandidates};
    if(side!=='guarded')this.spline=new EchoSpline(splineOptions);
    if(side==='echoSpline')return;
    if(this.id==='gbdt')this.fixedSpline=this.spline && (input.echoKnotM??2)===2 && (input.echoSupportM??8)===8
      ? this.spline : new EchoSpline({...splineOptions,spacing:2,support:8});
    if(this.id==='wmp'){
      const {parameters,refinement,clustering}=this.protocol.guarded;
      this.wmp=new PSPT({refinement,clustering,domain:bounds,...parameters},{densityOnly:true});
      this.evidence=new GapRangeEvidence(input.sigmaD);
    }
  }
  async loadModel({useGpu=false}={}){
    if(this.id==='gbdt')this.tree=await modelData('gbdt');
    else if(this.id==='gat')this.model=new GatGpr(await neuralRuntime('gat'),this.vehicles);
    else if(this.id==='arc'){
      this.model=new EchoArcCNN(await neuralRuntime('arc'));
      this.useGpu=useGpu;
      if(useGpu&&!this.closed)await this.model.enableGpu();
    }
  }
  close(){
    this.closed=true;
    this.model?.close?.();
  }
  stepLeft(wire,details=false) {
    const start=performance.now();
    wire=validateMeasuredSnapshot(wire);
    if(wire.t!==this.leftT+1)throw new RangeError('Snapshots must be consecutive from t=1');
    const fit=this.spline.step(wire,details);
    this.leftT=wire.t;
    return {...fit,candidates:[],ms:performance.now()-start};
  }
  stepRight(wire,sharedFit) {
    const start=performance.now();
    if(wire.t!==this.lastT+1)throw new RangeError('Snapshots must be consecutive from t=1');
    let result;
    if(this.wmp){
      const cut=this.protocol.guarded.threshold;
      const rows=selectGuarded(this.wmp,this.wmp.step(wire),cut);
      this.evidence.add(wire);result=wmpFrame(rows,start,true,this.evidence);
    }else{
      wire=validateMeasuredSnapshot(wire);
      if(this.id==='gbdt'){
        const f=sharedFit??this.fixedSpline.step(wire,true);
        result=this.correctedMap(f,wire.configs.length);
      }else if(this.useGpu){
        this.model.observe(wire);
        this.lastT=wire.t;
        return this.model.estimateAsync().then(map=>{
          const gpu=this.model.gpu;
          return {...map,ms:performance.now()-start,backend:gpu?'WebGPU':'CPU WASM',
            gpuCalls:gpu?.completedCalls??this.model.gpuCallsBeforeLoss??0,
            ...(gpu?.network?{gpuMode:'resident',gpuReadbacks:gpu.completedReadbacks}:{}),
            gpuAdapter:gpu?Object.values(gpu.adapterInfo).filter(Boolean).join(' '):''};
        });
      }else result=this.model.step(wire);
    }
    this.lastT=wire.t;
    return {...result,ms:performance.now()-start};
  }
  correctedMap(result,pairCount) {
    return {curves:result.fit?correctFit(result.fit,this.tree,pairCount,8):[],candidates:[]};
  }
  stepSide(side,wire) {
    if(side==='echoSpline')return this.stepLeft(wire);
    const result=this.stepRight(wire);
    if(this.id==='gat')result.stageTotalsMs={gat:this.model.gatMs,gpr:this.model.gprMs};
    return result;
  }
  step(wire) {
    const shared=this.fixedSpline===this.spline;
    const echoSpline=this.stepLeft(wire,shared);
    const guarded=this.stepRight(wire,shared?echoSpline:undefined);
    if(shared)delete echoSpline.fit;
    if(this.useGpu)return guarded.then(result=>({echoSpline,guarded:result}));
    return {echoSpline,guarded};
  }
}

// Final-only runs consume every measured snapshot in order, then materialize each wall once.
export async function estimateFinalMaps(input,domain,wires,stationaryCandidates) {
  if(!Array.isArray(wires) || !wires.length || wires.some((wire,i)=>wire.t!==i+1))
    throw new RangeError('Expected nonempty consecutive snapshots from t=1');
  const estimator=new EchoComparison(input,domain,undefined,stationaryCandidates);
  try{
    await estimator.loadModel({useGpu:!!globalThis.navigator?.gpu});
    const shared=estimator.fixedSpline===estimator.spline;
    for(const snapshot of wires){
      const wire=validateMeasuredSnapshot(snapshot);
      estimator.spline.observe(wire);
      if(estimator.wmp){
        estimator.wmp.observe(wire);
        estimator.evidence.add(wire);
      }else if(estimator.fixedSpline){
        if(!shared)estimator.fixedSpline.observe(wire);
      }else estimator.model.observe(wire);
    }
    const fit=estimator.spline.estimate(shared);
    let guarded;
    if(estimator.wmp){
      const rows=selectGuarded(estimator.wmp,estimator.wmp.report(),estimator.protocol.guarded.threshold);
      guarded=wmpFrame(rows,performance.now(),true,estimator.evidence);
      delete guarded.ms;
    }else if(estimator.fixedSpline){
      guarded=estimator.correctedMap(shared?fit:estimator.fixedSpline.estimate(true),wires.at(-1).configs.length);
    }else guarded=estimator.useGpu?await estimator.model.estimateAsync():estimator.model.estimate();
    const {fit:details,...echoSpline}=fit;
    return {echoSpline:{...echoSpline,candidates:[]},guarded};
  }finally{estimator.close();}
}
