import { rightMethods, canonicalRightMethod } from './right-methods.mjs?v=20261119-cnn-stride4';
import { modelData, neuralRuntime } from './model-runtime.mjs?v=20261119-cnn-stride4';
import { splineCnnProposal } from './echospline-cnn.mjs?v=20261119-cnn-stride4';
import { createSplineCnnGpu } from './spline-cnn-gpu.mjs?v=20261119-cnn-stride4';
import { correctFit } from './echospline-gbdt.mjs';
import { GatGpr } from './gat-gpr.mjs?v=20261119-cnn-stride4';
import { EchoArcCNN } from './echoarc-cnn.mjs?v=20261119-cnn-stride4';
import { createSplineGpu } from './spline-gpu.mjs?v=20261119-cnn-stride4';
import { EchoSpline } from './echospline.mjs?v=20261119-cnn-stride4';
import { GapRangeEvidence } from './bridge-evidence.mjs?v=20261112-chain-tips';
import { PSPT, validateMeasuredSnapshot } from './pspt.mjs?v=20261119-cnn-stride4';
import { protocolForFleet, selectGuarded, wmpFrame } from './comparison.mjs?v=20261112-upper-wmp';
import { computationDevice } from './compute-device.mjs?v=20261119-cnn-stride4';

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
        training:rightMethods[input.rightMethod].pairSelector?'Frozen pair-subset scorer trained on 48 training wall scenes from eight seed groups, with 3, 5, 7 and 10 vehicles; features use current and past observations only':input.rightMethod==='spline-cnn'?'Frozen upper-wall checkpoint refined on 4,736 independent walls with 3- and 10-vehicle measured prefixes':input.rightMethod==='spline-cnn-fast'?'이전 EchoSpline-CNN을 교사로 증류한 고정 체크포인트':'Frozen three-vehicle upper-wall checkpoint',
        revision:rightMethods[input.rightMethod].pairSelector?'20261118-pair-selection':input.rightMethod==='spline-cnn'?'20261118-rugged-canonical':input.rightMethod==='spline-cnn-fast'?'20261118-cnn-integrated':'20261115'}};
}

export class EchoComparison {
  constructor(input,domain,side,stationaryCandidates) {
    input={...input,rightMethod:canonicalRightMethod(input.rightMethod)};
    this.protocol=echoProtocol(input);this.side=side;
    this.id=input.rightMethod; this.vehicles=input.vehicles; this.lastT=0;this.leftT=0;
    this.isSplineCnn=this.id==='spline-cnn-fast';
    // EchoSpline-CNN map cadence: every snapshot still updates the measured tracks, but the GBDT/CNN map
    // is recomputed only at t=1,5,9,... and at the last configured snapshot; other steps hold the last map.
    this.cnnStride=this.isSplineCnn?4:1;this.finalT=input.snapshots;
    this.leftDeviceChoice=computationDevice(input,'echoSpline');
    this.deviceChoice=side==='echoSpline'?this.leftDeviceChoice:computationDevice(input,this.id);
    this.echoBackend=this.deviceChoice.spline?'gpu':'cpu';
    const bounds=input.scene==='paper-upper'?domain:undefined;
    const splineOptions={domain,upper:input.scene==='paper-upper',spacing:input.echoKnotM,support:input.echoSupportM,stationaryCandidates};
    if(side!=='guarded')this.spline=new EchoSpline(splineOptions);
    if(side==='echoSpline')return;
    this.pairMethod=rightMethods[this.id]?.pairSelector;
    if(this.pairMethod)this.pairEstimator=new EchoComparison({...input,rightMethod:'wmp',echoBackend:this.echoBackend},domain,'echoSpline',stationaryCandidates);
    if(this.id==='gbdt'||this.isSplineCnn)this.fixedSpline=this.spline && this.leftDeviceChoice.spline===this.deviceChoice.spline && (input.echoKnotM??2)===2 && (input.echoSupportM??8)===8
      ? this.spline : new EchoSpline({...splineOptions,spacing:2,support:8});
    if(this.id==='wmp'){
      const {parameters,refinement,clustering}=this.protocol.guarded;
      this.wmp=new PSPT({refinement,clustering,domain:bounds,...parameters},{densityOnly:true});
      this.evidence=new GapRangeEvidence(input.sigmaD);
    }
  }
  async loadModel({useGpu=false}={}){
    if(useGpu && this.leftDeviceChoice.spline && this.spline && !this.spline.grid.stationaryCandidates && !this.closed){
      this.splineGpuRequested=true;
      const gpu=await createSplineGpu();
      if(this.closed)gpu?.destroy();
      else this.splineGpu=gpu;
    }
    if(useGpu && this.echoBackend==='gpu' && this.fixedSpline && this.fixedSpline!==this.spline && !this.fixedSpline.grid.stationaryCandidates && !this.closed){
      const gpu=await createSplineGpu();
      if(this.closed)gpu?.destroy();else this.fixedSplineGpu=gpu;
    }
    if(this.side==='echoSpline' || this.closed)return;
    if(this.pairEstimator){
      const {createPairSelector}=await import('./echo-pair-selection/selector.mjs?v=20261119-cnn-stride4');
      if(this.closed)return;
      this.pairSelector=createPairSelector(this.pairMethod,this.vehicles);
      await this.pairEstimator.loadModel({useGpu});
      return;
    }
    if(this.isSplineCnn){
      [this.tree,this.cnn]=await Promise.all([modelData('gbdt'),neuralRuntime(this.id)]);
      if(this.cnn.weights['start.weight'].shape[2]!==23)
        throw new Error('EchoSpline-CNN requires a 23-channel checkpoint');
      if(useGpu&&this.deviceChoice.neural&&!this.closed){
        this.cnn.gpu=createSplineCnnGpu(this.cnn);
        try{await this.cnn.gpu?.ready;}
        catch(error){this.gpuFallbackReason=error.message;this.cnn.gpu?.close();this.cnn.gpu=null;}
      }
      if(this.closed)this.cnn.gpu?.close();
    }
    else if(this.id==='gbdt')this.tree=await modelData('gbdt');
    else if(this.id==='gat'){
      this.model=new GatGpr(await neuralRuntime('gat'),this.vehicles);
      if(useGpu&&this.deviceChoice.neural&&!this.closed)await this.model.useGpu();
    }
    else if(this.id==='arc'){
      this.model=new EchoArcCNN(await neuralRuntime('arc'));
      this.useGpu=useGpu&&this.deviceChoice.neural;
      if(this.useGpu&&!this.closed)await this.model.enableGpu();
    }
  }
  deviceInfo(){
    if(this.pairEstimator)return this.pairEstimator.deviceInfo();
    const gpu=this.cnn?.gpu??this.model?.gpu??this.fixedSplineGpu??this.splineGpu;
    return {requested:this.deviceChoice.requested,splineGpu:!!(this.fixedSplineGpu??this.splineGpu),
      neuralGpu:!!(this.cnn?.gpu??this.model?.gpu),densityGpu:false,
      adapter:gpu?.adapterInfo??null,
      ...(this.id==='gat'?{maxGraphRows:this.model?.maxGraphRows??0}:{}),
      fallbackReason:this.gpuFallbackReason??this.model?.gpuFallbackReason??null};
  }
  close(){
    this.closed=true;
    this.model?.close?.();
    this.pairEstimator?.close();
    if(this.cnn){this.cnn.closed=true;this.cnn.gpu?.close();}
    this.splineGpu?.destroy();
    this.fixedSplineGpu?.destroy();
  }
  async fitOnGpu(details,spline=this.spline,gpu=this.splineGpu){
    try{return await spline.estimateAsync(details,gpu);}
    catch(error){
      if(this.closed)throw error;
      this.gpuFallbackReason=error.message;
      if(spline===this.spline){this.gpuCallsBeforeLoss=gpu.completedCalls;this.splineGpu=null;}
      else {this.fixedGpuCallsBeforeLoss=gpu.completedCalls;this.fixedSplineGpu=null;}
      gpu.destroy();
      // The observation has already been recorded. Refit this same prefix on the CPU.
      return spline.estimate(details);
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
    const start=performance.now(),before=this.rightGpuCalls();
    if(wire.t!==this.lastT+1)throw new RangeError('Snapshots must be consecutive from t=1');
    let result;
    if(this.wmp){
      const rows=selectGuarded(this.wmp,this.wmp.step(wire),this.protocol.guarded.threshold);
      this.evidence.add(wire);result=wmpFrame(rows,start,true,this.evidence);
    }else{
      wire=validateMeasuredSnapshot(wire);
      if(this.pairEstimator){
        result=this.pairEstimator.stepLeft(this.pairSelector(wire));
      }else if(this.fixedSpline && this.cnnStride>1 && wire.t!==this.finalT && (wire.t-1)%this.cnnStride!==0){
        // A shared fit already observed this snapshot on the left side.
        if(!sharedFit)this.fixedSpline.observe(wire);
        result={curves:this.heldCurves,candidates:[]};
      }else if(this.fixedSpline){
        let f=sharedFit;
        if(!f && this.fixedSplineGpu){
          this.fixedSpline.observe(wire);
          f=this.fitOnGpu(true,this.fixedSpline,this.fixedSplineGpu);
        }
        f??=this.fixedSpline.step(wire,true);
        const hold=map=>{this.heldCurves=map.curves;return map;};
        const materialize=fit=>{const map=this.correctedMap(fit,wire.configs.length);return map?.then?map.then(hold):hold(map);};
        result=f?.then?f.then(materialize):materialize(f);
      }else if(this.id==='gat'&&this.model.gpu){
        result=this.model.stepAsync(wire);
      }else if(this.useGpu){
        this.model.observe(wire);
        result=this.model.estimateAsync().then(map=>{
          const gpu=this.model.gpu;
          return {...map,
            ...(gpu?.network?{gpuMode:'resident',gpuReadbacks:gpu.completedReadbacks}:{}),
            ...(gpu?.compact?{gpuCompact:true,gpuInputBytes:gpu.inputBytes,gpuOutputBytes:gpu.outputBytes,
              gpuOverflowReadbacks:gpu.overflowReadbacks}:{}),
            gpuAdapter:gpu?Object.values(gpu.adapterInfo).filter(Boolean).join(' '):''};
        });
      }else result=this.model.step(wire);
    }
    this.lastT=wire.t;
    const finish=map=>{
      const calls=this.rightGpuCalls(),gpuCallsThisStep=calls-before;
      return {...map,ms:performance.now()-start,
        ...(this.pairEstimator?{selectedPairCount:this.pairSelector.selectedCount,availablePairCount:wire.configs.length}:{}),
        ...(!this.pairEstimator && (['spline-cnn-fast','arc'].includes(this.id)||calls||this.deviceChoice.requested==='gpu')?{
          backend:gpuCallsThisStep?'WebGPU + CPU':['spline-cnn-fast','arc','gat'].includes(this.id)?'CPU WASM':'CPU',
          gpuCalls:calls,gpuCallsThisStep}: {})};
    };
    return result?.then?result.then(finish):finish(result);
  }
  rightGpuCalls(){
    return (this.cnn?.gpu?.completedCalls??this.cnn?.gpuCallsBeforeLoss??0)+
      (this.model?.gpu?.completedCalls??this.model?.gpuCallsBeforeLoss??0)+
      (this.fixedSplineGpu?.completedCalls??this.fixedGpuCallsBeforeLoss??0);
  }
  correctedMap(result,pairCount) {
    if(!result.fit)return {curves:[],candidates:[]};
    let fit=result.fit;
    const flip=this.isSplineCnn && fit.sign<0;
    if(flip){
      // Express the selected lower wall in the upper-wall coordinates used in training.
      fit={...fit,heights:fit.heights.map(y=>-y),prior:fit.prior.map(y=>-y),
        points:fit.points.map(([x,y,slope])=>[x,-y,-slope]),matches:fit.matches.map(m=>({...m,g:-m.g}))};
    }
    const curves=correctFit(fit,this.tree,pairCount,8);
    if(!this.isSplineCnn || !curves.length)return {curves,candidates:[]};
    const extra=this.cnn.weights['start.weight'].shape[2]>11?this.fixedSpline.cnnPoints(result.fit.sign):null;
    const evidence=extra?{points:flip?extra.map(points=>points.map(([x,y,s])=>[x,-y,-s])):extra,
      links:pairCount,sign:flip?-1:1}:undefined;
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
    if(this.id==='gat'){
      const finish=map=>({...map,stageTotalsMs:{gat:this.model.gatMs,gpr:this.model.gprMs}});
      return result?.then?result.then(finish):finish(result);
    }
    return result;
  }
  step(wire) {
    const shared=this.fixedSpline===this.spline;
    const finish=echoSpline=>{
      const guarded=this.stepRight(wire,shared?echoSpline:undefined);
      if(shared)delete echoSpline.fit;
      // Shared prefix work belongs to the left result; right timing/counters remain incremental.
      const join=result=>({echoSpline,guarded:result,...(shared&&(echoSpline.gpuCallsThisStep??0)>0?{sharedPrefix:{
        owner:'echoSpline',backend:echoSpline.backend??'CPU',ownerMs:echoSpline.ms,
        reusedGpuCallsThisStep:echoSpline.gpuCallsThisStep??0,reusedGpuCallsTotal:echoSpline.gpuCalls??0,
        includedInRightMs:false,includedInRightGpuCalls:false}}:{})});
      return guarded?.then?guarded.then(join):join(guarded);
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
      estimator.spline.observe(wire);
      if(estimator.wmp){
        estimator.wmp.observe(wire);
        estimator.evidence.add(wire);
      }else if(estimator.pairEstimator){
        estimator.pairEstimator.spline.observe(estimator.pairSelector(wire));
      }else if(estimator.fixedSpline){
        if(!shared)estimator.fixedSpline.observe(wire);
      }else if(estimator.id==='gat'&&estimator.model.gpu)await estimator.model.observeAsync(wire);
      else estimator.model.observe(wire);
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
      const fixedFit=shared?fit:estimator.fixedSplineGpu?
        await estimator.fitOnGpu(true,estimator.fixedSpline,estimator.fixedSplineGpu):estimator.fixedSpline.estimate(true);
      guarded=await estimator.correctedMap(fixedFit,wires.at(-1).configs.length);
    }else guarded=estimator.useGpu?await estimator.model.estimateAsync():estimator.model.estimate();
    const {fit:details,...echoSpline}=fit;
    return {echoSpline:{...echoSpline,candidates:[]},guarded};
  }finally{estimator.close();}
}
