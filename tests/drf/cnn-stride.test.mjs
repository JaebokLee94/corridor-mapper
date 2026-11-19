import test from 'node:test';
import assert from 'node:assert/strict';
import { EchoComparison } from '../../drf/echo-comparison.mjs';
import { createSceneGeometry, generateSnapshot } from '../../drf/scenario.mjs';
import { experimentSettings } from '../../drf/experiment-settings.mjs';

// EchoSpline-CNN recomputes its map at t=1,5,9,... and at the last snapshot; other steps hold the last map.
// Reference: the same estimator forced to recompute every step. Refresh steps and the final map must match it.
for(const vehicles of [3,10])for(const side of [undefined,'guarded'])
  test(`EchoSpline-CNN stride-4 cadence matches every-step updates (${vehicles} vehicles, ${side??'shared'})`,async()=>{
    const snapshots=14,settings=experimentSettings({scene:'paper-upper',vehicles,snapshots,seed:3296639392,rightMethod:'spline-cnn-fast'});
    const geometry=createSceneGeometry(settings);
    const wires=Array.from({length:snapshots},(_,i)=>generateSnapshot(settings,geometry.spans,i+1,geometry.wallModel).wire);
    const run=async stride=>{
      const model=new EchoComparison(settings,geometry.domain,side);
      await model.loadModel();
      assert.equal(model.cnnStride,4);
      model.cnnStride=stride;
      const maps=[];
      for(const wire of wires){
        const out=await (side?model.stepSide(side,wire):model.step(wire));
        maps.push((side?out:out.guarded).curves);
      }
      model.close();
      return maps;
    };
    const every=await run(1),strided=await run(4);
    assert.ok(every.at(-1).some(line=>line.length),'The final reference map is nonempty');
    let held,staleSteps=0;
    for(let t=1;t<=snapshots;t++){
      const refresh=t===snapshots||(t-1)%4===0;
      if(refresh){assert.deepEqual(strided[t-1],every[t-1],`refresh t=${t}`);held=every[t-1];}
      else{assert.deepEqual(strided[t-1],held,`held map t=${t}`);if(JSON.stringify(every[t-1])!==JSON.stringify(held))staleSteps++;}
    }
    assert.ok(staleSteps>0,'Some held steps differ from every-step updates, so the cadence is exercised');
  });
