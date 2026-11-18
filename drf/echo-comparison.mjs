import { rightMethods } from './right-methods.mjs?v=20261118-rugged-recovery';
import { modelData, neuralRuntime } from './model-runtime.mjs?v=20261118-rugged-recovery';
import { splineCnnProposal } from './echospline-cnn.mjs?v=20261118-rugged-recovery';
import { createSplineCnnGpu } from './spline-cnn-gpu.mjs?v=20261118-rugged-recovery';
import { correctFit } from './echospline-gbdt.mjs';
import { GatGpr } from './gat-gpr.mjs';
import { EchoArcCNN } from './echoarc-cnn.mjs?v=20261118-rugged-recovery';
import { createSplineGpu } from './spline-gpu.mjs?v=20261117-spline-gpu';
import { EchoSpline } from './echospline.mjs?v=20261118-rugged-recovery';
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
        ...(rightMethods[input.rightMethod].pairSelector?{parameters:{maxSelectedPairs:10,selectionInterval:10,trainedFleets:[3,5,7,10]}}:{}),
        training:rightMethods[input.rightMethod].pairSelector?'Frozen pair-subset scorer trained on 48 training wall scenes from eight seed groups, with 3, 5, 7 and 10 vehicles; features use current and past observations only':input.rightMethod==='spline-cnn'?'Frozen upper-wall checkpoint trained on 1,664 independent walls with 3- and 10-vehicle measured prefixes':'Frozen three-vehicle upper-wall checkpoint',
        revision:rightMethods[input.rightMethod].pairSelector?'20261118-pair-selection':input.rightMethod==='spline-cnn'?'20261118-rugged-recovery':'20261115'}};
}

export class EchoComparison {
  constructor(input,domain,side,stationaryCandidates) {
    this.protocol=echoProtocol(input);this.side=side;
    this.echoBackend=input.echoBackend??'cpu';
    if(!['cpu','gpu'].includes(this.echoBackend))throw new RangeError('Unknown EchoSpline compute device');
    this.id=input.rightMethod??'wmp'; this.vehicles=input.vehicles; this.lastT=0;this.leftT=0;
    if(this.id==='spline-cnn')this.cnnConfigs=[];
    const bounds=input.scene==='paper-upper'?domain:undefined;
    const splineOptions={domain,upper:input.scene==='paper-upper',spacing:input.echoKnotM,support:input.echoSupportM,stationaryCandidates};
    if(side!=='guarded')this.spline=new EchoSpline(splineOptions);
    if(side==='echoSpline')return;
    this.pairMethod=rightMethods[this.id]?.pairSelector;
    if(this.pairMethod)this.pairEstimator=new EchoComparison({...input,rightMethod:'wmp'},domain,'echoSpline',stationaryCandidates);
    if(this.id==='gbdt'||this.id==='spline-cnn')this.fixedSpline=this.spline && (input.echoKnotM??2)===2 && (input.echoSupportM??8)===8
      ? this.spline : new EchoSpline({...splineOptions,spacing:2,support:8});
    if(this.id==='wmp'){
      const {parameters,refinement,clustering}=this.protocol.guarded;
      this.wmp=new PSPT({refinement,clustering,domain:bounds,...parameters},{densityOnly:true});
      this.evidence=new GapRangeEvidence(input.sigmaD);
    }
  }
  async loadModel({useGpu=false}={}){
    if(useGpu && this.echoBackend==='gpu' && this.spline && !this.spline.grid.stationaryCandidates && !this.closed){
      this.splineGpuRequested=true;
      const gpu=await createSplineGpu();
      if(this.closed)gpu?.destroy();
      else this.splineGpu=gpu;
    }
    if(this.side==='echoSpline' || this.closed)return;
    if(this.pairEstimator){
      const {createPairSelector}=await import('./echo-pair-selection/selector.mjs?v=20261118-rugged-recovery');
      if(this.closed)return;
      this.pairSelector=createPairSelector(this.pairMethod,this.vehicles);
      await this.pairEstimator.loadModel({useGpu});
      return;
    }
    if(this.id==='spline-cnn'){
      [this.tree,this.cnn]=await Promise.all([modelData('gbdt'),neuralRuntime('spline-cnn')]);
      if(useGpu&&!this.closed){
        this.cnn.gpu=createSplineCnnGpu(this.cnn);
        try{await this.cnn.gpu?.ready;}
        catch{this.cnn.gpu?.close();this.cnn.gpu=null;}
      }
      if(this.closed)this.cnn.gpu?.close();
    }
    else if(this.id==='gbdt')this.tree=await modelData('gbdt');
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
    this.pairEstimator?.close();
    if(this.cnn){this.cnn.closed=true;this.cnn.gpu?.close();}
    this.splineGpu?.destroy();
  }
  async fitOnGpu(details){
    const gpu=this.splineGpu;
    try{return await this.spline.estimateAsync(details,gpu);}
    catch(error){
      if(this.closed)throw error;
      this.gpuCallsBeforeLoss=gpu.completedCalls;gpu.destroy();this.splineGpu=null;
      // The observation has already been recorded. Refit this same prefix on the CPU.
      return this.spline.estimate(details);
    }
  }
  stepLeft(wire,details=false) {
    const start=performance.now();
    wire=validateMeasuredSnapshot(wire);
    if(wire.t!==this.leftT+1)throw new RangeError('Snapshots must be consecutive from t=1');
    const gpu=this.splineGpu;
    this.spline.observe(wire);this.leftT=wire.t;
    if(gpu){
      const before=gpu.completedCalls;
      return this.fitOnGpu(details).then(fit=>{
        const gpuCalls=gpu.completedCalls,gpuCallsThisStep=gpuCalls-before;
        return {...fit,candidates:[],ms:performance.now()-start,
          backend:this.splineGpu && gpuCallsThisStep?'WebGPU + CPU':'CPU',gpuCalls,gpuCallsThisStep,
          gpuAdapter:Object.values(gpu.adapterInfo).filter(Boolean).join(' ')};
      });
    }
    const fit=this.spline.estimate(details);
    return {...fit,candidates:[],ms:performance.now()-start,
      ...(this.splineGpuRequested||this.gpuCallsBeforeLoss!=null?{backend:'CPU',gpuCalls:this.gpuCallsBeforeLoss??0,gpuCallsThisStep:0}:{})};
  }
  stepRight(wire,sharedFit) {
    const start=performance.now(),cnnCallsBefore=this.cnn?.gpu?.completedCalls??this.cnn?.gpuCallsBeforeLoss??0;
    if(wire.t!==this.lastT+1)throw new RangeError('Snapshots must be consecutive from t=1');
    let result;
    if(this.wmp){
      const cut=this.protocol.guarded.threshold;
      const rows=selectGuarded(this.wmp,this.wmp.step(wire),cut);
      this.evidence.add(wire);result=wmpFrame(rows,start,true,this.evidence);
    }else{
      wire=validateMeasuredSnapshot(wire);
      this.cnnConfigs?.push(...wire.configs);
      if(this.pairEstimator){
        result=this.pairEstimator.stepLeft(this.pairSelector(wire));
      }else if(this.fixedSpline){
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
            ...(gpu?.compact?{gpuCompact:true,gpuInputBytes:gpu.inputBytes,gpuOutputBytes:gpu.outputBytes,
              gpuOverflowReadbacks:gpu.overflowReadbacks}:{}),
            gpuAdapter:gpu?Object.values(gpu.adapterInfo).filter(Boolean).join(' '):''};
        });
      }else result=this.model.step(wire);
    }
    this.lastT=wire.t;
    const finish=map=>{
      const calls=this.cnn?.gpu?.completedCalls??this.cnn?.gpuCallsBeforeLoss??0;
      return {...map,ms:performance.now()-start,
        ...(this.pairEstimator?{selectedPairCount:this.pairSelector.selectedCount,availablePairCount:wire.configs.length}:{}),
        ...(this.id==='spline-cnn'?{
        backend:this.cnn.gpu&&calls>cnnCallsBefore?'WebGPU + CPU':'CPU WASM',gpuCalls:calls,gpuCallsThisStep:calls-cnnCallsBefore}: {})};
    };
    return result?.then?result.then(finish):finish(result);
  }
  correctedMap(result,pairCount) {
    if(!result.fit)return {curves:[],candidates:[]};
    let fit=result.fit;
    const flip=this.id==='spline-cnn' && fit.sign<0;
    if(flip){
      // Express the selected lower wall in the upper-wall coordinates used in training.
      fit={...fit,heights:fit.heights.map(y=>-y),prior:fit.prior.map(y=>-y),
        points:fit.points.map(([x,y,slope])=>[x,-y,-slope]),matches:fit.matches.map(m=>({...m,g:-m.g}))};
    }
    const curves=correctFit(fit,this.tree,pairCount,8);
    if(this.id!=='spline-cnn' || !curves.length)return {curves,candidates:[]};
    const extra=this.cnn.weights['start.weight'].shape[2]>11?this.fixedSpline.cnnPoints(result.fit.sign):null;
    const evidence=extra?{points:flip?extra.map(points=>points.map(([x,y,s])=>[x,-y,-s])):extra,
      configs:this.cnnConfigs,links:pairCount,sign:flip?-1:1}:undefined;
    const map=({base})=>({curves:curves.map(line=>line.map(([x])=>{
      const y=base[Math.round((x-fit.x[0])/.2)];
      if(!Number.isFinite(y))throw new Error('EchoSpline-CNN lost a supported wall sample');
      return [x,flip?-y:y];
    })),candidates:[]});
    const proposal=splineCnnProposal(this.cnn,fit,curves,evidence);
    return proposal?.then?proposal.then(map):map(proposal);
  }
  stepSide(side,wire) {
    if(side==='echoSpline')return this.stepLeft(wire);
    const result=this.stepRight(wire);
    if(this.id==='gat')result.stageTotalsMs={gat:this.model.gatMs,gpr:this.model.gprMs};
    return result;
  }
  step(wire) {
    const shared=this.fixedSpline===this.spline;
    const finish=echoSpline=>{
      const guarded=this.stepRight(wire,shared?echoSpline:undefined);
      if(shared)delete echoSpline.fit;
      if(guarded?.then)return guarded.then(result=>({echoSpline,guarded:result}));
      return {echoSpline,guarded};
    };
    const left=this.stepLeft(wire,shared);
    return left instanceof Promise?left.then(finish):finish(left);
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
      estimator.cnnConfigs?.push(...wire.configs);
      estimator.spline.observe(wire);
      if(estimator.wmp){
        estimator.wmp.observe(wire);
        estimator.evidence.add(wire);
      }else if(estimator.pairEstimator){
        estimator.pairEstimator.spline.observe(estimator.pairSelector(wire));
      }else if(estimator.fixedSpline){
        if(!shared)estimator.fixedSpline.observe(wire);
      }else estimator.model.observe(wire);
    }
    const fit=estimator.splineGpu?await estimator.fitOnGpu(shared):estimator.spline.estimate(shared);
    let guarded;
    if(estimator.wmp){
      const rows=selectGuarded(estimator.wmp,estimator.wmp.report(),estimator.protocol.guarded.threshold);
      guarded=wmpFrame(rows,performance.now(),true,estimator.evidence);
      delete guarded.ms;
    }else if(estimator.pairEstimator){
      const pair=estimator.pairEstimator;
      guarded=pair.splineGpu?await pair.fitOnGpu(false):pair.spline.estimate();
      guarded={...guarded,candidates:[],selectedPairCount:estimator.pairSelector.selectedCount,availablePairCount:wires.at(-1).configs.length};
    }else if(estimator.fixedSpline){
      guarded=await estimator.correctedMap(shared?fit:estimator.fixedSpline.estimate(true),wires.at(-1).configs.length);
    }else guarded=estimator.useGpu?await estimator.model.estimateAsync():estimator.model.estimate();
    const {fit:details,...echoSpline}=fit;
    return {echoSpline:{...echoSpline,candidates:[]},guarded};
  }finally{estimator.close();}
}
