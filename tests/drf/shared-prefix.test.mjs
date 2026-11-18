import test from 'node:test';
import assert from 'node:assert/strict';
import { EchoComparison } from '../../drf/echo-comparison.mjs';

function comparison(shared=true){
  const estimator=Object.create(EchoComparison.prototype);
  estimator.id='gbdt';estimator.spline={};estimator.fixedSpline=shared?estimator.spline:{};
  return estimator;
}

test('combined shared prefixes retain their left owner without duplicating right time or GPU calls',async()=>{
  for(const asyncLeft of [false,true])for(const asyncRight of [false,true])for(const prefixGpu of [false,true]){
    const estimator=comparison(),fit={heights:[1,2]},curves=[[[0,1],[1,2]]];
    const left={fit,curves,candidates:[],ms:21,backend:prefixGpu?'WebGPU + CPU':'CPU',
      gpuCalls:prefixGpu?18:0,gpuCallsThisStep:prefixGpu?3:0};
    const right={curves,candidates:[],ms:4,backend:'CPU',gpuCalls:0,gpuCallsThisStep:0};
    let leftCalls=0,rightCalls=0;
    estimator.stepLeft=(_wire,details)=>{leftCalls++;assert.equal(details,true);return asyncLeft?Promise.resolve(left):left;};
    estimator.stepRight=(_wire,prefix)=>{rightCalls++;assert.equal(prefix,left);assert.equal(prefix.fit,fit);return asyncRight?Promise.resolve(right):right;};
    const result=await estimator.step({t:1});
    assert.equal(leftCalls,1);assert.equal(rightCalls,1);assert.equal(result.echoSpline,left);
    assert.equal(result.guarded,right);assert.equal(result.guarded.curves,curves);assert.equal(result.guarded.ms,4);
    assert.equal(result.guarded.backend,'CPU');assert.equal(result.guarded.gpuCalls,0);assert.equal(result.guarded.gpuCallsThisStep,0);
    if(prefixGpu)assert.deepEqual(result.sharedPrefix,{owner:'echoSpline',backend:left.backend,ownerMs:21,
      reusedGpuCallsThisStep:prefixGpu?3:0,reusedGpuCallsTotal:prefixGpu?18:0,
      includedInRightMs:false,includedInRightGpuCalls:false});
    else assert.equal(Object.hasOwn(result,'sharedPrefix'),false);
    assert.equal(Object.hasOwn(right,'sharedPrefix'),false);
    assert.equal(Object.hasOwn(result.echoSpline,'fit'),false);
  }
});

test('nonshared combined and independent side results retain their original objects and counters',async()=>{
  const estimator=comparison(false),left={ms:20,backend:'WebGPU + CPU',gpuCalls:8,gpuCallsThisStep:2},
    right={ms:7,backend:'CPU',gpuCalls:0,gpuCallsThisStep:0};
  estimator.stepLeft=()=>left;
  estimator.stepRight=(_wire,shared)=>{assert.equal(shared,undefined);return right;};
  const combined=await estimator.step({t:1});
  assert.equal(combined.echoSpline,left);assert.equal(combined.guarded,right);
  assert.equal(estimator.stepSide('echoSpline',{t:2}),left);
  assert.equal(estimator.stepSide('guarded',{t:2}),right);
  assert.equal(Object.hasOwn(right,'sharedPrefix'),false);assert.equal(right.ms,7);assert.equal(right.gpuCalls,0);
});
