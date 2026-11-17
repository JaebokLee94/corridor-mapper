import test from 'node:test';
import assert from 'node:assert/strict';
import { EchoComparison, estimateFinalMaps } from '../../drf/echo-comparison.mjs';
import { createSceneGeometry, generateSnapshot } from '../../drf/scenario.mjs';
import { experimentSettings } from '../../drf/experiment-settings.mjs';

test('final maps equal the last causal outputs for every right-hand method', async () => {
  const settings=experimentSettings({scene:'paper-upper',vehicles:3,snapshots:16,seed:3296639392,sigmaDGeometry:3});
  const geometry=createSceneGeometry(settings), domain=geometry.domain;
  const wires=Array.from({length:16},(_,i)=>generateSnapshot(settings,geometry.spans,i+1,geometry.wallModel).wire);
  for(const [rightMethod,echoKnotM] of [['gbdt',2],['gbdt',4],['gat',2],['arc',2],['wmp',2]]){
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
