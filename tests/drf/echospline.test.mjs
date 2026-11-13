import test from 'node:test';
import assert from 'node:assert/strict';
import {EchoSpline} from '../../drf/echospline.mjs';
import {experimentSettings} from '../../drf/experiment-settings.mjs';
import {createPSPTEvaluator} from '../../drf/pspt-evaluate.mjs';
function flat(t,level,spread=true){
  const positions=[[t-1,1],[t+1,spread?-1:1],[t+4,spread?2:1]],configs=[];
  for(let i=0;i<3;i++)for(let j=i+1;j<3;j++){
    const a=positions[i],b=positions[j];configs.push({i:i+1,j:j+1,pHat_i:a,pHat_j:b,paths:[{dHat:Math.hypot(a[0]-b[0],2*level-a[1]-b[1])}]});
  }return {t,configs};
}
test('multi-echo fit recovers a flat reflector from exact image-source distances; reflection ambiguity abstains',()=>{
  for(const level of [8,-8]){
    const method=new EchoSpline({domain:[0,40]});for(let t=1;t<=20;t++)method.observe(flat(t,level));
    const {curves,ambiguous}=method.estimate();assert.equal(ambiguous,false);assert.ok(curves.flat().length>90);
    for(const [,y] of curves.flat())assert.ok(Math.abs(y-level)<.005);
  }
  const blind=new EchoSpline({domain:[0,40]});for(let t=1;t<=20;t++)blind.observe(flat(t,8,false));
  assert.deepEqual(blind.estimate().curves,[]);assert.equal(blind.estimate().ambiguous,true);
});
test('support reach changes output extent; input and parameter validation preserve reproducibility',()=>{
  const lengths=[1,8].map(support=>{const method=new EchoSpline({domain:[0,40],upper:true,spacing:4,support});
    for(let t=1;t<=10;t++)method.observe(flat(t,8));return method.estimate().curves.flat().length;});
  assert.ok(lengths[1]>lengths[0]);assert.equal(experimentSettings({echoKnotM:'4',echoSupportM:5}).echoKnotM,4);assert.throws(()=>experimentSettings({echoKnotM:0}));
});
test('fitted curve uses whole-map geometry, without fabricated fragment decisions or bridges',()=>{
  const s={walls:[[[0,8],[10,8]]],input:{},truth:[{t:1,configs:[]}]};
  const e=createPSPTEvaluator(s,{}).step({t:1,candidates:[],curves:[[[0,8],[10,8]]]}, {diagnostics:{}});
  assert.equal(e.interpolation.rawMap.mapF1,1);assert.equal(e.precision,null);assert.equal(e.supportedCount,null);assert.equal(e.firstSupportCount,null);
});
