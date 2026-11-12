import test from 'node:test';
import assert from 'node:assert/strict';
import { generateScenario, generateSnapshot, normalizeInput, truePoses } from '../../drf/scenario.mjs';
import { createWalls, evaluate } from '../../drf/wall.mjs';
import { createGrid, createField } from '../../drf/field.mjs';
import { visible } from '../../drf/specular.mjs';
import { makeWire } from '../../drf/wire.mjs';

test('vehicle limits and fixed trajectories support 2–20 vehicles without moving the common prefix',()=>{
  for (let vehicles=2;vehicles<=20;vehicles++) assert.equal(normalizeInput({vehicles}).vehicles,vehicles);
  assert.equal(normalizeInput({vehicles:'20'}).vehicles,20);
  for (const vehicles of [-1,0,1,2.5,20.5,21,NaN,Infinity,'twenty'])
    assert.throws(()=>normalizeInput({vehicles}),/vehicles|trajectories/);
  assert.equal(normalizeInput().snapshots,120);
  for (let snapshots=1;snapshots<=120;snapshots++) assert.equal(normalizeInput({snapshots}).snapshots,snapshots);
  for (const snapshots of [0,120.5,121,NaN,Infinity]) assert.throws(()=>normalizeInput({snapshots}),/snapshots/);
  const spans=createWalls({ scene: 'reference' });
  for (let t=1;t<=60;t++) {
    const fleet=truePoses(t,20);
    assert.equal(fleet.length,20);
    const legacy=[4,7,10].map((x0,v)=>{
      const x=x0+.75*t;
      return [x,15+2*Math.sin(2*Math.PI*x/30+v+1)];
    });
    assert.deepEqual(fleet.slice(0,3),legacy,'Original three trajectories must retain their exact numbers');
    for (const count of [2,5,19]) assert.deepEqual(truePoses(t,count),fleet.slice(0,count));
    for (const [x,y] of fleet) {
      assert.ok(Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&x<=60);
      const wallY=wall=>{
        const span=spans.find(s=>s.wall===wall&&x>=s.C[0][0]&&x<=s.C[0][0]+s.h);
        assert.ok(span,'The legacy sixty-snapshot prefix must lie on a wall span x interval');
        return evaluate(span,(x-span.C[0][0])/span.h).s[1];
      };
      assert.ok(y>wallY(0)&&y<wallY(1),'True vehicles must remain inside the reference walls');
    }
  }
});

test('actual twenty-vehicle snapshot has 190 pairs, shares poses, preserves old pair measurements and reaches the field',async()=>{
  const input={scene:'reference',snapshots:1,grid:100,seed:1},fleet=await generateScenario({...input,vehicles:20});
  const truth=fleet.truth[0],wire=fleet.wire[0],ids=new Set(),poses=new Map();
  assert.equal(truth.p.length,20);assert.equal(truth.poseNoise.length,20);
  assert.equal(truth.configs.length,190);assert.equal(wire.configs.length,190);
  for (const [k,config] of wire.configs.entries()) {
    const {i,j,pHat_i,pHat_j,Sigma_i,Sigma_j,paths}=config;
    assert.ok(Number.isInteger(i)&&Number.isInteger(j)&&i>=1&&i<j&&j<=20);
    assert.ok(!ids.has(`${i}:${j}`),'Bistatic pairs must be unique');ids.add(`${i}:${j}`);
    assert.equal(truth.configs[k].i,i);assert.equal(truth.configs[k].j,j);
    for (const [id,pose,covariance] of [[i,pHat_i,Sigma_i],[j,pHat_j,Sigma_j]]) {
      assert.equal(pose.length,2);assert.ok(pose.every(Number.isFinite));
      assert.equal(covariance.length,3);assert.ok(covariance.every(Number.isFinite));
      if (poses.has(id)) assert.deepEqual(pose,poses.get(id),'One noisy pose per vehicle must be reused by every pair');
      else poses.set(id,pose);
    }
    assert.ok(paths.every(p=>Number.isFinite(p.dHat)&&p.sigmaD===fleet.input.sigmaD));
  }
  assert.equal(ids.size,190);assert.equal(poses.size,20);
  for (const snapshots of [60,80]) {
    const longer=generateSnapshot(normalizeInput({...fleet.input,snapshots}),fleet.spans,1);
    assert.deepEqual(longer,{truth,wire},'Requested future snapshots must not change the twenty-vehicle first snapshot');
  }
  for (const vehicles of [3,5]) {
    const smaller=await generateScenario({...input,vehicles}),prefix=configs=>configs.filter(c=>c.j<=vehicles);
    assert.deepEqual(truth.p.slice(0,vehicles),smaller.truth[0].p);
    assert.deepEqual(truth.poseNoise.slice(0,vehicles),smaller.truth[0].poseNoise);
    assert.deepEqual(prefix(truth.configs),smaller.truth[0].configs,'Changing fleet size must not change common pair truth');
    assert.deepEqual(prefix(wire.configs),smaller.wire[0].configs,'Changing fleet size must not change common pair wire');
  }
  const frame=createField(createGrid(100,100)).step(wire);
  assert.equal(frame.t,1);assert.equal(frame.Dbar.length,10000);assert.equal(frame.betaHat.length,10000);
  assert.ok(frame.Dbar.every(v=>Number.isFinite(v)&&v>=0));
  assert.ok(frame.betaHat.every(v=>Number.isFinite(v)&&v>=0&&v<=1+1e-7));
  assert.ok(frame.Q>0);assert.equal(frame.Q,frame.admitted);
  assert.equal(frame.admitted+frame.rejected,wire.configs.reduce((n,c)=>n+c.paths.length,0));
});

test('eighty snapshots preserve the sixty-snapshot wire and continue through the finite open exit',async()=>{
  const input={scene:'reference',vehicles:3,grid:150,seed:1},short=await generateScenario({...input,snapshots:60}),long=await generateScenario({...input,snapshots:80});
  assert.equal(long.truth.length,80);assert.equal(long.wire.length,80);
  assert.deepEqual(long.truth.slice(0,60),short.truth,'Extra observation time cannot rescale or alter the past truth');
  assert.deepEqual(long.wire.slice(0,60),short.wire,'Extra observation time cannot alter the causal measurement prefix');
  assert.deepEqual(long.spans,short.spans);assert.deepEqual(long.walls,short.walls,'The finite wall model must not be lengthened');
  const bins=truth=>{
    const result=[new Uint8Array(10),new Uint8Array(10)];
    for (const snapshot of truth) for (const c of snapshot.configs) for (const q of [...c.specular,...c.diffuse]) {
      assert.ok(q.s.every(Number.isFinite)&&q.s[0]>=0&&q.s[0]<=60,'All emitted scattering points remain on finite walls');
      if (q.s[0]>=55) result[q.wall][Math.min(9,Math.floor((q.s[0]-55)/.5))]=1;
    }
    return result.map(b=>Array.from(b));
  };
  assert.deepEqual(bins(short.truth),[Array(10).fill(0),Array(10).fill(0)]);
  assert.deepEqual(bins(long.truth),[Array(10).fill(1),Array(10).fill(1)],'This fixed-seed run must actually observe both terminal wall intervals');
  for (let t=1;t<=80;t++) {
    const fleet=truePoses(t,20);
    for (let v=0;v<20;v++) {
      const x0=v<3?4+3*v:1+13*(v-3)/16;
      assert.deepEqual(fleet[v],[x0+.75*t,15+2*Math.sin(2*Math.PI*(x0+.75*t)/30+v+1)]);
    }
    for (const vehicles of [2,3,5,19]) assert.deepEqual(truePoses(t,vehicles),fleet.slice(0,vehicles));
  }
  const complete=truePoses(80,20);
  assert.ok(complete.every(p=>p.every(Number.isFinite)&&p[0]>60));
  assert.equal(Math.min(...complete.map(p=>p[0])),61);assert.equal(Math.max(...complete.map(p=>p[0])),74);
  const final=generateSnapshot(normalizeInput({...input,vehicles:20,snapshots:80}),long.spans,80);
  assert.deepEqual(final.truth.p,complete);assert.equal(final.wire.configs.length,190);
  assert.deepEqual(makeWire(final.wire),final.wire,'Outgoing measured poses and any remaining paths must remain finite');
  assert.deepEqual(final.truth.configs.filter(c=>c.j<=3),long.truth[79].configs);
  assert.deepEqual(final.wire.configs.filter(c=>c.j<=3),long.wire[79].configs);
  assert.ok(visible(long.spans,[61,15],[60,7]),'There is no artificial closing wall across the open exit');
});

test('the upper-wall preset gives straight 1 m steps, exact poses, specular returns and the same measured fleet prefix',async()=>{
  const settings={scene:'paper-upper',seed:6,snapshots:2};
  const small=await generateScenario({...settings,vehicles:3}), large=await generateScenario({...settings,vehicles:10});
  assert.deepEqual(large.domain,[0,100,-20,50]);
  assert.deepEqual([...new Set(large.spans.map(s=>s.wall))],[1]);
  assert.deepEqual([large.input.sigmaP,large.input.sigmaD,large.input.resolution],[0,.4,.6]);
  for (let t=0;t<2;t++) {
    assert.deepEqual(small.wire[t].configs,large.wire[t].configs.filter(c=>c.j<=3));
    for(const [i,p] of large.truth[t].p.entries()){
      assert.ok(p[1]<=large.wallGeneration.bounds.ymin-3);
      if(t) assert.deepEqual(p,[large.truth[0].p[i][0]+1,large.truth[0].p[i][1]]);
    }
    for(const c of large.wire[t].configs) {
      assert.deepEqual(c.pHat_i,large.truth[t].p[c.i-1]);assert.deepEqual(c.Sigma_i,[0,0,0]);
      assert.ok(c.paths.every(p=>p.sigmaD===.4));
    }
    assert.ok(large.truth[t].configs.every(c=>c.diffuse.length===0));
  }
});
