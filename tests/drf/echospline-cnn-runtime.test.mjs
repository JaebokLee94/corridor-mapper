import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { neuralRuntime } from '../../drf/model-runtime.mjs';
import { splineCnnProposal, decodeSplineCnn } from '../../drf/echospline-cnn.mjs';

test('frozen EchoSpline-CNN reproduces the H200 path on two supported intervals', async () => {
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
  // Independent H200 PyTorch FP32 reference; CPU/CUDA logit discrepancy was 1.34e-5.
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
