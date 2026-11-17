import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentSettings } from '../../drf/experiment-settings.mjs';
import { createSceneGeometry,generateSnapshot } from '../../drf/scenario.mjs';
import { neuralRuntime } from '../../drf/model-runtime.mjs';
import { GatGpr } from '../../drf/gat-gpr.mjs';
import { EchoArcCNN } from '../../drf/echoarc-cnn.mjs';

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
