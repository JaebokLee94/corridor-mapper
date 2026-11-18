import test from 'node:test';
import assert from 'node:assert/strict';
import { EchoComparison, estimateFinalMaps } from '../../drf/echo-comparison.mjs';
import { createSceneGeometry, generateSnapshot, generateScenario } from '../../drf/scenario.mjs';
import { experimentSettings } from '../../drf/experiment-settings.mjs';
import { EchoSpline } from '../../drf/echospline.mjs';
import { correctFit } from '../../drf/echospline-gbdt.mjs';
import { splineCnnProposal } from '../../drf/echospline-cnn.mjs';
import { modelData, neuralRuntime } from '../../drf/model-runtime.mjs';

test('final maps equal the last causal outputs for every right-hand method', async () => {
  const settings=experimentSettings({scene:'paper-upper',vehicles:3,snapshots:16,seed:3296639392,sigmaDGeometry:3});
  const geometry=createSceneGeometry(settings), domain=geometry.domain;
  const wires=Array.from({length:16},(_,i)=>generateSnapshot(settings,geometry.spans,i+1,geometry.wallModel).wire);
  const aliasMaps=new Map();
  for(const [rightMethod,echoKnotM] of [['spline-cnn',2],['spline-cnn',4],['spline-cnn-fast',2],['spline-cnn-fast',4],['gbdt',2],['gbdt',4],['gat',2],['arc',2],['wmp',2]]){
    const input={...settings,rightMethod,echoKnotM};
    const live=new EchoComparison(input,domain);
    await live.loadModel();
    let expected;
    for(const wire of wires)expected=live.step(wire);
    delete expected.echoSpline.ms;
    delete expected.guarded.ms;
    for(const key of ['backend','gpuCalls','gpuCallsThisStep'])delete expected.guarded[key];
    const final=await estimateFinalMaps(input,domain,wires);
    assert.deepEqual(final,expected,rightMethod);
    if(rightMethod==='spline-cnn'){
      assert.equal(live.id,'spline-cnn-fast');assert.equal(live.cnnConfigs,undefined);
      aliasMaps.set(echoKnotM,final);
    }else if(rightMethod==='spline-cnn-fast')assert.deepEqual(final,aliasMaps.get(echoKnotM),'Saved CNN alias uses the identical current model');
    live.close();
  }
  await assert.rejects(estimateFinalMaps(settings,domain,wires.slice(1)),/consecutive/);
  const exposed={...wires[1],truth:geometry.spans};
  await assert.rejects(estimateFinalMaps(settings,domain,[wires[0],exposed]),/non-wire/);
});

for(const rightMethod of ['spline-cnn','spline-cnn-fast'])test(`${rightMethod} mirrors wall heights when the measured fit selects the lower wall`,async()=>{
  const input=experimentSettings({scene:'paper-upper',vehicles:3,snapshots:16,seed:3296639392,rightMethod});
  const scene=createSceneGeometry(input),model=new EchoComparison(input,scene.domain,'guarded');
  const wires=Array.from({length:16},(_,i)=>generateSnapshot(input,scene.spans,i+1,scene.wallModel).wire);
  await model.loadModel();
  for(const w of wires){model.fixedSpline.observe(w);model.cnnConfigs?.push(...w.configs);}
  const {fit}=model.fixedSpline.estimate(true);
  const upper=(await model.correctedMap({fit},wires[0].configs.length)).curves;
  assert.ok(upper.flat().length>0);
  const mirror=([x,y])=>[x,-y];
  const mirrored=new EchoComparison(input,scene.domain,'guarded');
  await mirrored.loadModel();
  for(const w of wires){
    const configs=w.configs.map(c=>({...c,pHat_i:mirror(c.pHat_i),pHat_j:mirror(c.pHat_j),
      Sigma_i:[c.Sigma_i[0],-c.Sigma_i[1],c.Sigma_i[2]],Sigma_j:[c.Sigma_j[0],-c.Sigma_j[1],c.Sigma_j[2]]}));
    mirrored.fixedSpline.observe({...w,configs});mirrored.cnnConfigs?.push(...configs);
  }
  const lower=(await mirrored.correctedMap({fit:{...fit,sign:-1,heights:fit.heights.map(y=>-y),prior:fit.prior.map(y=>-y),
    points:fit.points.map(([x,y,s])=>[x,-y,-s]),matches:fit.matches.map(m=>({...m,g:-m.g}))}},wires[0].configs.length)).curves;
  assert.deepEqual(lower,upper.map(line=>line.map(mirror)));
  model.close();mirrored.close();
});

test('the archived teacher retains its independent H200 separated-peak reference outside active routing',async()=>{
  const input=experimentSettings({scene:'paper-upper',wallSide:'upper',seed:3566396965,vehicles:3,snapshots:100,
    sigmaP:0,sigmaD:.4,sigmaM:10.6,deltaM:16,sigmaDGeometry:2.77,deltaD:2,roughness:0,lambda0:0,
    cellStep:.02,resolution:.6,specular:true,grid:150,band:4,perimeter:'exact'});
  const scene=await generateScenario(input);
  const spline=new EchoSpline({domain:scene.domain,upper:true,spacing:2,support:8});
  for(const wire of scene.wire)spline.observe(wire);
  const {fit}=spline.estimate(true),links=scene.wire.at(-1).configs.length;
  assert.equal(fit.sign,1);
  const curves=correctFit(fit,await modelData('gbdt'),links,8);
  const teacher=await neuralRuntime('spline-cnn');
  assert.equal(teacher.weights['start.weight'].shape[2],26);
  const {base}=splineCnnProposal(teacher,fit,curves,{points:spline.cnnPoints(fit.sign),
    configs:scene.wire.flatMap(w=>w.configs),links,sign:1});
  assert.ok(curves.flat().some(([x])=>Math.abs(x-79.8)<1e-8));
  const peak=base[Math.round((79.8-fit.x[0])/.2)];
  // Independent frozen H200 PyTorch path; the target seed was excluded from training.
  assert.ok(Math.abs(peak-49.58793040412688)<.002, String(peak));
});
