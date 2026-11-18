import test from 'node:test';
import assert from 'node:assert/strict';
import {EchoComparison,estimateFinalMaps} from '../../drf/echo-comparison.mjs';
import {EchoSpline} from '../../drf/echospline.mjs';
import {experimentSettings} from '../../drf/experiment-settings.mjs';
import {createPairSelector} from '../../drf/echo-pair-selection/selector.mjs';

const methods=[['pair-ridge','ridge'],['pair-gbdt','gbdt'],['pair-extra-trees','extraTrees']];
const domain=[0,60,-10,25];

function measuredWire(vehicles,t) {
  const positions=Array.from({length:vehicles},(_,i)=>[
    .4*t+2*(i%5), (i*2)%5-2+Math.max(0,t-60)*.02,
  ]);
  const configs=[];
  for(let i=0;i<vehicles;i++)for(let j=i+1;j<vehicles;j++) {
    const a=positions[i],b=positions[j];
    // Exact image-source ranges for a horizontal reflector at y=12 m.
    const dHat=Math.hypot(a[0]-b[0],24-a[1]-b[1]);
    const paths=t>33&&t<43&&(i+j)%3===0?[]:[{dHat,sigmaD:.4}];
    if(paths.length&&(t+i+j)%7===0)paths.push({dHat:dHat+3,sigmaD:.4});
    configs.push({i,j,pHat_i:a,pHat_j:b,Sigma_i:[0,0,0],Sigma_j:[0,0,0],paths});
  }
  return {t,configs};
}

for(const vehicles of [3,5,7,10]) {
  test(`pair methods preserve all 100 causal prefixes and final-only maps for ${vehicles} vehicles`,async()=>{
    const wires=Array.from({length:100},(_,i)=>measuredWire(vehicles,i+1));
    const original=structuredClone(wires);
    for(const [rightMethod,method] of methods) {
      const input=experimentSettings({scene:'paper-upper',vehicles,snapshots:100,rightMethod,
        echoKnotM:vehicles===5?4:2,echoSupportM:vehicles===5?5:8});
      assert.deepEqual(experimentSettings(JSON.parse(JSON.stringify(input))),input);
      const options={domain,upper:true,spacing:input.echoKnotM,support:input.echoSupportM};
      const reference=new EchoSpline(options),full=new EchoSpline(options);
      const select=createPairSelector(method,vehicles);
      const side=vehicles===10?'guarded':undefined;
      const comparison=new EchoComparison(input,domain,side);
      await comparison.loadModel();
      try {
        for(const wire of wires) {
          const selected=select(wire);
          assert.equal(selected.configs.length,wire.configs.length);
          const expected=reference.step(selected);
          full.observe(wire);
          const result=side?await comparison.stepSide(side,wire):await comparison.step(wire);
          const actual=side?result:result.guarded;
          assert.deepEqual(actual.curves,expected.curves,`${rightMethod} at t=${wire.t}`);
          assert.deepEqual(actual.candidates,[]);
          assert.equal(actual.selectedPairCount,select.selectedCount);
          assert.equal(actual.availablePairCount,vehicles*(vehicles-1)/2);
          assert.ok(actual.selectedPairCount<=10&&Number.isFinite(actual.ms)&&actual.ms>=0);
          if(!side)assert.deepEqual(result.echoSpline.curves,full.estimate().curves);
        }
        const final=await estimateFinalMaps(input,domain,wires);
        assert.deepEqual(final.guarded.curves,reference.estimate().curves);
        assert.deepEqual(final.echoSpline.curves,full.estimate().curves);
        assert.equal(final.guarded.selectedPairCount,select.selectedCount);
      } finally {
        comparison.close();
      }
      assert.deepEqual(wires,original,'Selection and inference preserve shared measured inputs');
    }
  });
}

test('a rejected time or changed pair order leaves the selector ready for the valid next snapshot',()=>{
  for(const vehicles of [2,3,4,5,7,10])for(const [,method] of methods) {
    const select=createPairSelector(method,vehicles);
    assert.throws(()=>select(measuredWire(vehicles,2)),/consecutive/);
    select(measuredWire(vehicles,1));
    if([3,5,7,10].includes(vehicles)) {
      const invalid=measuredWire(vehicles,2);
      invalid.configs.reverse();
      assert.throws(()=>select(invalid),/Pair order changed/);
    }
    const wire=measuredWire(vehicles,2),selected=select(wire);
    assert.equal(selected.t,2);
    if(vehicles===2||vehicles===4)assert.equal(selected,wire);
  }
});

test('new method boundaries reject truth fields and invalid times before consuming a measurement',async()=>{
  for(const [rightMethod] of methods) {
    const model=new EchoComparison({scene:'paper-upper',vehicles:3,rightMethod},domain,'guarded');
    await model.loadModel();
    try {
      assert.throws(()=>model.stepSide('guarded',{...measuredWire(3,1),truth:[]}),/non-wire/);
      assert.throws(()=>model.stepSide('guarded',measuredWire(3,2)),/consecutive/);
      await model.stepSide('guarded',measuredWire(3,1));
      assert.equal(model.lastT,1);
    } finally {
      model.close();
    }
  }
});

test('pair selection reuses asynchronous spline screening and its device-loss recovery',async()=>{
  const input={scene:'paper-upper',vehicles:7,rightMethod:'pair-gbdt'};
  const model=new EchoComparison(input,domain,'guarded');
  await model.loadModel();
  const reference=new EchoSpline({domain,upper:true}),select=createPairSelector('gbdt',7);
  let fail=false,destroyed=false;
  const gpu={
    completedCalls:0,adapterInfo:{vendor:'test'},
    bind(x,observations) {
      const mask=new Uint32Array(observations.length*Math.ceil(x.length/32)).fill(0xffffffff);
      const scan=async()=>{
        if(fail)throw Error('Device lost');
        gpu.completedCalls++;
        return mask;
      };
      scan.batch=async heights=>{await scan();return heights.map(()=>mask);};
      return scan;
    },
    destroy(){destroyed=true;},
  };
  model.pairEstimator.splineGpu=gpu;
  try {
    for(let t=1;t<=24;t++) {
      if(t===16)fail=true;
      const wire=measuredWire(7,t);
      const expected=reference.step(select(wire));
      const actual=await model.stepSide('guarded',wire);
      assert.deepEqual(actual.curves,expected.curves);
      assert.equal(actual.backend,actual.gpuCallsThisStep?'WebGPU + CPU':'CPU');
    }
    assert.ok(gpu.completedCalls>0&&destroyed);
    assert.equal(model.pairEstimator.spline.obs.length,reference.obs.length);
  } finally {
    model.close();
  }
});
