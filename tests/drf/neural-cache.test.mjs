import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentSettings } from '../../drf/experiment-settings.mjs';
import { createSceneGeometry,generateSnapshot } from '../../drf/scenario.mjs';
import { neuralRuntime } from '../../drf/model-runtime.mjs';
import { arcPeakCapacity } from '../../drf/arc-gpu.mjs';
import { GatGpr } from '../../drf/gat-gpr.mjs';
import { EchoArcCNN, decodeArc, decodeArcPeaks } from '../../drf/echoarc-cnn.mjs';

test('learned maps preserve their prefix and reuse a map across an empty measurement',async()=>{
  const input=experimentSettings({scene:'paper-upper',vehicles:3,snapshots:16,seed:3296639392,sigmaDGeometry:3});
  const scene=createSceneGeometry(input);
  const wires=Array.from({length:16},(_,i)=>generateSnapshot(input,scene.spans,i+1,scene.wallModel).wire);
  const empty={t:17,configs:wires[15].configs.map(c=>({...c,paths:[]}))};
  for(const [id,Estimator] of [['gat',GatGpr],['arc',EchoArcCNN]]){
    const rt=await neuralRuntime(id);
    let calls=0;
    const online=new Estimator({...rt,call(...args){calls++;return rt.call(...args);}},3);
    const batch=new Estimator(rt,3);
    let last;
    for(const wire of wires){last=online.step(wire);batch.observe(wire);}
    assert.ok(last.curves.length);
    assert.deepEqual(batch.estimate(),last,id);
    const before=calls,expected=structuredClone(last);
    last.curves[0][0][1]+=100;
    assert.deepEqual(online.step(empty),expected,id);
    assert.equal(calls,before,id);
  }
});

test('an empty frame with a changed pair count rescales existing CNN votes',()=>{
  // Expose the normalized input to check the training normalization independently of the decoder.
  const model=new EchoArcCNN({});
  model.network=input=>[[[0,input.reduce((sum,v)=>sum+v,0)]]];
  const link={pHat_i:[4,2],pHat_j:[8,3],paths:[{dHat:12}]};
  const one=model.step({configs:[link]}).curves[0][0][1];
  const empty={...link,paths:[]};
  const two=model.step({configs:[empty,empty]}).curves[0][0][1];
  assert.ok(one>two&&two>0);
  assert.equal(model.step({configs:[empty]}).curves[0][0][1],one);
});

test('resident Arc decodes one logit image and reuses its wall across an empty frame',async()=>{
  const model=new EchoArcCNN({data:{threshold:.7}});
  const logits=new Float32Array(144*201).fill(-8);
  logits.fill(8,40*201,41*201);
  let forwards=0;
  model.gpu={async network(){forwards++;return logits;}};
  const link={pHat_i:[4,2],pHat_j:[8,3],paths:[{dHat:12}]};
  model.observe({configs:[link]});
  const first=await model.estimateAsync();
  assert.deepEqual(first.curves,[Array.from({length:201},(_,x)=>[x*.5,0])]);
  first.curves[0][0][1]=1;
  model.observe({configs:[{...link,paths:[]}]});
  assert.deepEqual((await model.estimateAsync()).curves[0][0],[0,0]);
  assert.equal(forwards,1);
});

test('Arc awaits convolution results and recovers the current measured prefix after GPU loss',async()=>{
  const rt=await neuralRuntime('arc'),model=new EchoArcCNN(rt),reference=new EchoArcCNN(rt);
  const link={pHat_i:[4,2],pHat_j:[8,3],paths:[{dHat:12}]};
  let fail=false,destroyed=0;
  const gpu=model.gpu={
    completedCalls:0,
    async convolution(...args){
      if(fail)throw new Error('Device lost');
      this.completedCalls++;
      return model.convolution(...args);
    },
    destroy(){destroyed++;}
  };
  async function compare(config){
    const wire={configs:[config]};
    model.observe(wire);
    assert.deepEqual(await model.estimateAsync(),reference.step(wire));
    assert.deepEqual(model.input,reference.input);
  }
  await compare(link);
  assert.equal(gpu.completedCalls,11);
  await compare({...link,paths:[]});
  assert.equal(gpu.completedCalls,11);
  fail=true;
  await compare(link);
  assert.equal(destroyed,1);
  assert.equal(model.gpu,null);
  assert.equal(model.gpuCallsBeforeLoss,11);
  await compare(link);
});

test('compact peak packets preserve boundary rows, sub-cell positions, and equal-height ties',()=>{
  const w=201,logits=new Float32Array(w*144).fill(-8);
  const stride=1+4*arcPeakCapacity,packet=new Float32Array(w*stride);
  // Both plateau cells are peaks. After interpolation they have the same y.
  // Keep both curves and their original column/link order.
  for(let x=0;x<4;x++){
    logits[w+x]=1;
    logits[40*w+x]=logits[41*w+x]=2;
    logits[141*w+x]=0;logits[142*w+x]=3;
    packet.set([4,1,-8,1,-8,40,-8,2,2,41,2,2,-8,142,0,3,-8],stride*x);
  }
  const curves=decodeArcPeaks(packet,.7);
  assert.deepEqual(curves,decodeArc(logits,.7));
  assert.equal(curves.length,4);
  assert.deepEqual(curves[1],curves[2]);
  assert.deepEqual(curves[3][3],[1.5,-20+.5*(142-2/7)]);
  const plateau=new Float32Array(w*144).fill(1);
  assert.equal(decodeArcPeaks(plateau,.7).length,142);
});

test('compact input broadcasts the normalized scalar exactly and recovers after GPU loss',async()=>{
  const rt=await neuralRuntime('arc'),model=new EchoArcCNN(rt),reference=new EchoArcCNN(rt);
  const wire={configs:[{pHat_i:[4,2],pHat_j:[8,3],paths:[{dHat:12}]}]};
  const expected=reference.step(wire);
  let checked=false;
  model.gpu={compact:true,completedCalls:0,network(plane){
    assert.equal(plane.length,201*144);
    assert.equal(model.denseInput,undefined);
    for(let i=0;i<plane.length;i++){
      for(let c=0;c<9;c++)assert.equal(plane[i],reference.input[i*9+c]);
    }
    checked=true;throw new Error('GPU lost');
  },destroy(){}};
  model.observe(wire);
  assert.deepEqual(await model.estimateAsync(),expected);
  assert.ok(checked);
  assert.deepEqual(model.input,reference.input);
  assert.deepEqual(model.step(wire),reference.step(wire));
});
