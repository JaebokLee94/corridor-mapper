import test from 'node:test';
import assert from 'node:assert/strict';
import { rerankEchoSplineCNN } from '../../drf/spline-rerank.mjs';
import { neuralRuntime } from '../../drf/model-runtime.mjs';
import { splineCnnProposal, decodeSplineCnn } from '../../drf/echospline-cnn.mjs';

test('frozen EchoSpline-CNN reproduces the H200 path on two supported intervals', async () => {
  const rt=await neuralRuntime('spline-cnn');
  const x=Array.from({length:41},(_,i)=>i*.2);
  const anchor=x.map(v=>3+.05*v), heights=x.map((v,i)=>anchor[i]+.15*Math.sin(v));
  const points=Array.from({length:30},(_,i)=>[.28*i,3+.1*i+i%3,.25*(i%5-2)]);
  const curves=[x.slice(0,18).map((v,i)=>[v,anchor[i]]),x.slice(22).map((v,i)=>[v,anchor[i+22]])];
  const result=splineCnnProposal(rt,{x,heights,points},curves);
  for(let i=18;i<22;i++)assert.ok(Number.isNaN(result.base[i]));
  // Independent reference: the frozen PyTorch model on H200. Allow TF32 versus WASM FP32 rounding.
  const expectedLogits=[[0,0,-4.554873],[16,7,-6.366501],[32,14,6.073967],[40,0,2.209099],
    [40,17,9.844384],[40,22,6.971990],[47,32,3.432189],[63,35,-1.774060],[80,40,-2.137519]];
  for(const [z,j,ref] of expectedLogits)assert.ok(Math.abs(result.logits[z*x.length+j]-ref)<.01);
  for(const [i,ref] of [[0,3.029741],[8,3.472776],[17,3.591509],[22,5.572350],[33,5.745720],[40,5.787809]]){
    assert.ok(Math.abs(result.base[i]-ref)<.002);
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

test('an unsupported second height mode preserves the CNN wall and its coverage gap',()=>{
  const x=Array.from({length:81},(_,i)=>i*.2),anchor=x.map(q=>q<1?NaN:10);
  const logits=new Float32Array(81*x.length);
  const points=Array.from({length:8},(_,i)=>[8+i*.02,14,0]);
  // Seven returns at the flat wall range provide too few independent configurations for a change.
  const wires=x.slice(0,7).map(q=>({configs:[{pHat_i:[q,0],pHat_j:[q+2,0],paths:[{dHat:2*Math.hypot(10,1)}]}]}));
  const output=rerankEchoSplineCNN({x,base:anchor,anchor,logits,points,wires});
  assert.equal(output.accepted,0);
  assert.deepEqual(output.heights,anchor.map(h=>Number.isFinite(h)?h:null));
});
