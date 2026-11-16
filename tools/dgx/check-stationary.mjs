// Build stationary.node first. Compare every causal prefix and the full fit used by GBDT.
import assert from 'node:assert/strict';
import {EchoSpline} from '../../drf/echospline.mjs';
import {stationaryCandidates} from './stationary.mjs';

for(const vehicles of [3,10]) for(const wallY of [8,-8]) {
  const domain=[0,70], cpu=new EchoSpline({domain}), h200=new EchoSpline({domain,stationaryCandidates});
  let vertices=0;
  for(let t=1;t<=18;t++) {
    const poses=Array.from({length:vehicles},(_,i)=>[t+i*.55,(i%3-1)*1.2]);
    const configs=[];
    for(let i=0;i<vehicles;i++) for(let j=i+1;j<vehicles;j++) {
      const a=poses[i], b=poses[j];
      configs.push({i:i+1,j:j+1,pHat_i:a,pHat_j:b,paths:[{dHat:Math.hypot(a[0]-b[0],2*wallY-a[1]-b[1])}]});
    }
    const wire={t,configs}, a=cpu.step(wire,true), b=h200.step(wire,true);
    assert.deepStrictEqual(b,a);
    if(t===18) {
      for(const point of a.curves.flat()){assert.ok(Math.abs(point[1]-wallY)<.005);vertices++;}
      assert.ok(vertices>0);
    }
  }
  console.log(JSON.stringify({vehicles,wallY,identicalPrefixes:18,finalVertices:vertices}));
}
