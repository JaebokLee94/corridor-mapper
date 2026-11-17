import test from 'node:test';
import assert from 'node:assert/strict';
import { EchoComparison, estimateFinalMaps } from '../../drf/echo-comparison.mjs';
import { createSceneGeometry, generateSnapshot, generateScenario } from '../../drf/scenario.mjs';
import { experimentSettings } from '../../drf/experiment-settings.mjs';

test('final maps equal the last causal outputs for every right-hand method', async () => {
  const settings=experimentSettings({scene:'paper-upper',vehicles:3,snapshots:16,seed:3296639392,sigmaDGeometry:3});
  const geometry=createSceneGeometry(settings), domain=geometry.domain;
  const wires=Array.from({length:16},(_,i)=>generateSnapshot(settings,geometry.spans,i+1,geometry.wallModel).wire);
  for(const [rightMethod,echoKnotM] of [['spline-cnn',2],['spline-cnn',4],['gbdt',2],['gbdt',4],['gat',2],['arc',2],['wmp',2]]){
    const input={...settings,rightMethod,echoKnotM};
    const live=new EchoComparison(input,domain);
    await live.loadModel();
    let expected;
    for(const wire of wires)expected=live.step(wire);
    delete expected.echoSpline.ms;
    delete expected.guarded.ms;
    assert.deepEqual(await estimateFinalMaps(input,domain,wires),expected,rightMethod);
  }
  await assert.rejects(estimateFinalMaps(settings,domain,wires.slice(1)),/consecutive/);
  const exposed={...wires[1],truth:geometry.spans};
  await assert.rejects(estimateFinalMaps(settings,domain,[wires[0],exposed]),/non-wire/);
});

test('EchoSpline-CNN mirrors wall heights when the measured fit selects the lower wall',async()=>{
  const input=experimentSettings({scene:'paper-upper',vehicles:3,snapshots:16,seed:3296639392,rightMethod:'spline-cnn'});
  const scene=createSceneGeometry(input),model=new EchoComparison(input,scene.domain,'guarded');
  const wires=Array.from({length:16},(_,i)=>generateSnapshot(input,scene.spans,i+1,scene.wallModel).wire);
  await model.loadModel();
  for(const w of wires)model.fixedSpline.observe(w);
  const {fit}=model.fixedSpline.estimate(true);
  const upper=model.correctedMap({fit},wires[0].configs.length).curves;
  assert.ok(upper.flat().length>0);
  const mirror=([x,y])=>[x,-y];
  const lower=model.correctedMap({fit:{...fit,sign:-1,heights:fit.heights.map(y=>-y),prior:fit.prior.map(y=>-y),
    points:fit.points.map(([x,y,s])=>[x,-y,-s]),matches:fit.matches.map(m=>({...m,g:-m.g}))}},wires[0].configs.length).curves;
  assert.deepEqual(lower,upper.map(line=>line.map(mirror)));
});

test('the spline-cnn method returns the frozen single CNN path on a separated peak',async()=>{
  const input=experimentSettings({scene:'paper-upper',wallSide:'upper',seed:3566396965,vehicles:3,snapshots:100,
    sigmaP:0,sigmaD:.4,sigmaM:10.6,deltaM:16,sigmaDGeometry:2.77,deltaD:2,roughness:0,lambda0:0,
    cellStep:.02,resolution:.6,specular:true,grid:150,band:4,perimeter:'exact',rightMethod:'spline-cnn'});
  const scene=await generateScenario(input);
  const {guarded}=await estimateFinalMaps(input,scene.domain,scene.wire);
  const peak=guarded.curves.flat().find(([x])=>Math.abs(x-79.8)<1e-8);
  assert.ok(peak);
  // The frozen PyTorch path is 39.92031 m here; range rescoring instead returned 50.079 m.
  assert.ok(Math.abs(peak[1]-39.92031)<.002, String(peak));
});
