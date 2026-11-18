import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { modelData, neuralRuntime } from '../../drf/model-runtime.mjs';
import { EchoComparison } from '../../drf/echo-comparison.mjs';
import { splineCnnProposal, decodeSplineCnn } from '../../drf/echospline-cnn.mjs';

test('archived previous EchoSpline-CNN reproduces the H200 path on two supported intervals', async () => {
  const rt=await neuralRuntime('spline-cnn');
  const ref=JSON.parse(readFileSync(new URL('./fixtures/echospline-cnn.json',import.meta.url)));
  const {x,heights,points,curves,pointsWide3,pointsWide5,wires,links,sign}=ref.fixture;
  assert.equal(rt.data.checkpointSha256,ref.checkpointSha256);
  let input;
  const call=rt.call;
  rt.call=(method,args,...rest)=>{
    if(method==='convolutionXY'&&!input)input=args[0].slice();
    return call(method,args,...rest);
  };
  const result=splineCnnProposal(rt,{x,heights,points},curves,
    {points:[pointsWide3,pointsWide5],configs:wires.flatMap(w=>w.configs),links,sign});
  for(let i=18;i<22;i++)assert.ok(Number.isNaN(result.base[i]));
  // Independent H200 PyTorch FP32 reference; tolerances cover backend rounding.
  for(const [c,z,j,value] of ref.expectedFeatureProbes)assert.ok(Math.abs(input[(z*x.length+j)*26+c]-value)<.001);
  for(const [z,j,value] of ref.expectedLogits)assert.ok(Math.abs(result.logits[z*x.length+j]-value)<.002,`logit ${z},${j}`);
  for(const [i,value] of ref.expectedHeights){
    if(value===null)assert.ok(Number.isNaN(result.base[i]));
    else assert.ok(Math.abs(result.base[i]-value)<.0001,`height ${i}: ${result.base[i]} vs ${value}`);
  }
});

test('a separated modal path is selected independently after the support gap',()=>{
  const n=13, anchor=Float64Array.from({length:n},(_,j)=>j===5?NaN:3);
  const logits=new Float32Array(81*n).fill(-30);
  for(let j=0;j<n;j++)logits[(j<5?20:65)*n+j]=10;
  const y=decodeSplineCnn(logits,anchor);
  assert.ok(Number.isNaN(y[5]));
  for(let j=0;j<n;j++)if(j!==5)assert.ok(Math.abs(y[j]-(j<5?-5:13))<1e-9);
});


test('the current checkpoint and saved alias share 23 non-range channels and skip every range call',async()=>{
  const rt=await neuralRuntime('spline-cnn-fast');
  const ref=JSON.parse(readFileSync(new URL('./fixtures/echospline-cnn.json',import.meta.url)));
  const {x,heights,points,curves,pointsWide3,pointsWide5,links,sign}=ref.fixture;
  assert.equal(rt.weights['start.weight'].shape[2],23);
  assert.notEqual(rt.data.checkpointSha256,ref.checkpointSha256);
  let input,convolutions=0;
  const call=rt.call;
  rt.call=(method,args,...rest)=>{
    assert.notEqual(method,'rangeVotes','23-channel inference must not compute range features');
    if(method==='convolutionXY'){convolutions++;input??=args[0].slice();}
    return call(method,args,...rest);
  };
  const fit={x,heights,points},before=JSON.stringify(fit);
  const result=splineCnnProposal(rt,fit,curves,{points:[pointsWide3,pointsWide5],links,sign,
    get configs(){assert.fail('The fast checkpoint must not read range configurations');}});
  assert.equal(convolutions,rt.data.dilations.length+2);
  assert.equal(input.length,23*81*x.length);assert.equal(result.logits.length,81*x.length);
  assert.equal(JSON.stringify(fit),before);
  // The feature contract is unchanged except for removing range channels 18:21.
  for(const [c,z,j,value] of ref.expectedFeatureProbes){
    if(c>=18&&c<=20)continue;
    const channel=c>=21?c-3:c;
    assert.ok(Math.abs(input[(z*x.length+j)*23+channel]-value)<.001,`feature ${c} -> ${channel}`);
  }
  for(const [i,value] of ref.expectedHeights){
    if(value===null)assert.ok(Number.isNaN(result.base[i]));
    else assert.ok(Number.isFinite(result.base[i])&&Math.abs(result.base[i]-result.anchor[i])<=16+1e-10);
  }
  const settings={scene:'paper-upper',vehicles:3,rightMethod:'spline-cnn'},beforeSettings=JSON.stringify(settings);
  const alias=new EchoComparison(settings,[0,100,-20,50],'guarded');
  try{
    await alias.loadModel();
    assert.equal(JSON.stringify(settings),beforeSettings);
    assert.equal(alias.id,'spline-cnn-fast');assert.equal(alias.cnnConfigs,undefined);
    assert.equal(alias.cnn.weights['start.weight'].shape[2],23);
    assert.equal(alias.cnn.data.checkpointSha256,rt.data.checkpointSha256);
    const aliasCall=alias.cnn.call;
    alias.cnn.call=(method,...args)=>{assert.notEqual(method,'rangeVotes');return aliasCall(method,...args);};
    const actual=splineCnnProposal(alias.cnn,fit,curves,{points:[pointsWide3,pointsWide5],links,sign,
      get configs(){assert.fail('Saved CNN aliases must not read range configurations');}});
    assert.deepEqual(actual,result,'Compatibility alias preserves the current model output exactly');
  }finally{alias.close();}
});

test('current CNN selection rejects a range-model asset instead of silently changing its contract',async()=>{
  const original=await modelData('spline-cnn'),previous=globalThis.__echoModelData;
  const model=new EchoComparison({scene:'paper-upper',vehicles:3,rightMethod:'spline-cnn-fast'},[0,100,-20,50],'guarded');
  try{
    globalThis.__echoModelData={...previous,'spline-cnn-fast':original};
    await assert.rejects(model.loadModel(),/23|channel|range/i);
  }finally{
    model.close();
    if(previous===undefined)delete globalThis.__echoModelData;else globalThis.__echoModelData=previous;
  }
});
