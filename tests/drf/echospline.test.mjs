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
test('explicit stage device choices survive settings round trips',()=>{
  assert.equal(experimentSettings(experimentSettings({echoBackend:'cpu'})).echoBackend,'cpu');
  assert.equal(experimentSettings(experimentSettings({echoBackend:'gpu'})).echoBackend,'gpu');
  assert.throws(()=>experimentSettings({echoBackend:'other'}),/device/);
});
test('fitted curve uses whole-map geometry, without fabricated fragment decisions or bridges',()=>{
  const s={walls:[[[0,8],[10,8]]],input:{},truth:[{t:1,configs:[]}]};
  const e=createPSPTEvaluator(s,{}).step({t:1,candidates:[],curves:[[[0,8],[10,8]]]}, {diagnostics:{}});
  assert.equal(e.interpolation.rawMap.mapF1,1);assert.equal(e.precision,null);assert.equal(e.supportedCount,null);assert.equal(e.firstSupportCount,null);
});

test('reused inverse points survive a late turn, returned diagnostics edits and both mirror hypotheses',()=>{
  const options={domain:[0,40]},online=new EchoSpline(options),history=[];
  for(let t=1;t<=16;t++){
    const wire=flat(t,8);
    if(t>=13)for(const c of wire.configs){c.pHat_i[1]+=.1*(t-12);c.pHat_j[1]+=.1*(t-12);}
    history.push(wire);
    const cached=online.step(wire,true),fresh=new EchoSpline(options);
    for(const frame of history)fresh.observe(frame);
    assert.deepEqual(cached,fresh.estimate(true));
    if(cached.fit)cached.fit.points[0][1]+=100;
  }
});

test('a conservative stationarity mask keeps the full-grid fit, including lower-wall diagnostics',()=>{
  const options={domain:[0,40]},cpu=new EchoSpline(options);const testedSigns=new Set();
  const masked=new EchoSpline({...options,stationaryCandidates:(x,obs,sign)=>{
    testedSigns.add(sign);
    const words=new Uint32Array(obs.length*Math.ceil(x.length/32)).fill(0xffffffff);
    return ()=>words;
  }});
  for(let t=1;t<=12;t++){
    const wire=flat(t,-8);
    assert.deepEqual(masked.step(wire,true),cpu.step(wire,true));
  }
  assert.deepEqual([...testedSigns].sort(),[-1,1]);
});

test('closed short tracks retain their end velocities after missing echoes and a later turn',()=>{
  const options={domain:[0,40]},cached=new EchoSpline(options),history=[];
  for(let t=1;t<=22;t++){
    const wire=flat(t,8);
    for(const config of wire.configs){
      if(config.i===1&&config.j===2&&t>6&&t<=12)config.paths=[];
      if(t>10){
        config.pHat_i=[config.pHat_i[0],config.pHat_i[1]+.06*(t-10)];
        config.pHat_j=[config.pHat_j[0],config.pHat_j[1]+.06*(t-10)];
      }
    }
    history.push(wire);
    const actual=cached.step(wire,true),fresh=new EchoSpline(options);
    for(const frame of history)fresh.observe(frame);
    assert.deepEqual(actual,fresh.estimate(true));
  }
});
