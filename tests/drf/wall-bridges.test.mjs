import test from 'node:test';
import assert from 'node:assert/strict';
import {completeWallGaps} from '../../drf/bridge-curves.mjs';
import {createPSPTEvaluator,psptSnapshotCsv} from '../../drf/pspt-evaluate.mjs';

const patch=(id,x,y=0,phi=0,other={})=>({id,center:[x,y],phi,kappa:0,sg:1,ell:1,status:'supported',...other});
test('bridge only an unambiguous gap between supported, outward-facing endpoints',()=>{
  const a=patch('a',0), b=patch('b',2.95);
  assert.equal(completeWallGaps([a,b]).length,1);
  for(const neighbor of [patch('long',4.01),patch('side',0,0.2),patch('angle',2.9,0,0.45),
      patch('overlap',1.9),patch('held',2.95,0,0,{status:'pending'})])
    assert.deepEqual(completeWallGaps([a,neighbor]),[]);
  assert.deepEqual(completeWallGaps([a,b,patch('fork',2.92,0.02)]),[]);
  assert.deepEqual(completeWallGaps([a,b,patch('cover',1.48)]),[]);
  const reversed=completeWallGaps([patch('b',2.95,0,Math.PI),a]);
  assert.equal(reversed.length,1); assert.ok(Math.abs(reversed[0].points[0][0]-1)<1e-12);
});
test('gap length is bounded by the shorter full fragment on either side, including equality',()=>{
  for (const [left,right] of [[0.75,1.5],[1.5,0.75]]) {
    const a=patch('a',0,0,0,{ell:left});
    const withGap=gap=>patch('b',left+right+gap,0,0,{ell:right});
    assert.equal(completeWallGaps([a,withGap(1.5)]).length,1);
    assert.equal(completeWallGaps([a,withGap(1.51)]).length,0);
  }
});
test('cubic follows both estimated endpoint tangents and stays between the endpoints',()=>{
  const phi=Math.PI/30,c=Math.cos(phi),s=Math.sin(phi);
  const [b]=completeWallGaps([patch('a',-c,-s,phi),patch('b',1+c,-s,-phi)]);
  assert.deepEqual(b.points, [[0,0],[1,0]]);
  assert.deepEqual(b.curve[0], b.points[0]); assert.deepEqual(b.curve.at(-1),b.points[1]);
  for(const [x,y] of b.curve) {
    assert.ok(Math.abs(y - Math.tan(phi)*x*(1-x)) < 1e-12);
    assert.ok(x>=0 && x<=1);
  }
});
test('a forced inflection retains the accepted chord even if the fragment orientation is reversed',()=>{
  const phi=Math.PI/18, c=Math.cos(phi), s=Math.sin(phi);
  for (const angle of [phi, phi+Math.PI]) {
    const [link]=completeWallGaps([patch('a',-c,-s,phi),patch('b',1+c,s,angle)]);
    assert.ok(link);
    assert.deepEqual(link.curve,link.points);
  }
});
test('observed missing samples and added off-wall length measure different outcomes on identical bridges',()=>{
  const candidates=[patch('a',0),patch('b',3)], bridges=completeWallGaps(candidates);
  const evaluate = walls => {
    const scene={walls,truth:[{configs:[{specular:[{s:[1.5,0]}],diffuse:[]}]}]};
    return createPSPTEvaluator(scene).step({t:1,candidates},{diagnostics:{}},bridges);
  };
  const valid=evaluate([[[-1,0],[4,0]]]), broken=evaluate([[[-1,0],[1,0]],[[2,0],[4,0]]]);
  for (const shape of [valid.interpolation,valid.interpolation.hermite]) {
    assert.equal(shape.missing,0); assert.ok(shape.recovered>0); assert.equal(shape.offWallM,0);
  }
  for (const shape of [broken.interpolation,broken.interpolation.hermite]) {
    assert.equal(shape.falseBridges,1); assert.ok(Math.abs(shape.offWallM-0.2)<1e-12);assert.equal(shape.recovered,0);
  }
  const rows=psptSnapshotCsv([{t:1}],[valid],{includeInterpolation:true}).trim().split('\r\n');
  assert.equal(rows[0].split(',').length,rows[1].split(',').length);
  assert.ok(rows[0].includes('hermite_added_offwall_m'));
});

test('wide linear joins remain optional, reject ambiguous partners, and report closing a real opening', () => {
  const a = patch('left', 0), b = patch('right', 7);
  const extra = [];
  assert.deepEqual(completeWallGaps([a, b], extra), []);
  assert.deepEqual(extra.map(link => link.points), [[[1,0],[6,0]]]);
  for (const input of [[a,patch('distant',10.1)], [a,b,patch('fork',7,.5)]]) {
    const alternatives = [];
    completeWallGaps(input,alternatives);
    assert.deepEqual(alternatives, []);
  }
  const scene = {walls:[[[-1,0],[1,0]], [[6,0],[8,0]]],truth:[{configs:[]}]};
  const e = createPSPTEvaluator(scene).step({t:1,candidates:[a,b]}, {diagnostics:{}}, [], extra);
  assert.equal(e.interpolation.count,0);
  assert.equal(e.interpolation.extended.falseBridges,1);
  assert.ok(Math.abs(e.interpolation.extended.offWallM - 4.2) < 1e-9);
});

test('a wider linear link requires repeated, local range support throughout the gap', async () => {
  const {GapRangeEvidence} = await import('../../drf/bridge-evidence.mjs');
  const left = patch('L',0), right = patch('R',6), pieces = [left,right];
  function lineSnapshot(t, {opening=false, clutter=false}={}) {
    const configs = [];
    for (const centre of [1.5,2.5,3.5,4.5]) {
      // For these poses above y=0, the mirror path has length hypot(2*h, 0.4).
      for (const h of [2,2.5,3,3.5]) {
        const ranges = opening && centre===2.5 ? [] : clutter ? [2*h-.6,2*h,2*h+.6] : [2*h];
        configs.push({pHat_i:[centre-.2,h],pHat_j:[centre+.2,h],
          paths:ranges.map(r=>({dHat:Math.hypot(r,.4)}))});
      }
    }
    return {t,configs};
  }
  function run(cfg) {
    const evidence = new GapRangeEvidence(.1);
    for (let t=1;t<=2;t++) {
      evidence.add(lineSnapshot(t,cfg));
      assert.equal(completeWallGaps(pieces,[],evidence).length,0);
    }
    evidence.add(lineSnapshot(3,cfg));
    const extra=[], base=completeWallGaps(pieces,extra,evidence);
    assert.equal(extra.length+base.length,1);
    return base;
  }
  const joined=run({});
  assert.deepEqual(joined[0].points,[[1,0],[5,0]]);
  assert.equal(joined[0].measuredLinear,true);
  assert.deepEqual(joined[0].curve, joined[0].points);
  assert.equal(run({opening:true}).length,0);
  assert.equal(run({clutter:true}).length,0);
  const scene={walls:[[[-1,0],[7,0]]],truth:[{configs:[{specular:[{s:[3,0]}],diffuse:[]}]}]};
  const score=createPSPTEvaluator(scene).step({t:1,candidates:pieces},{diagnostics:{}},joined,[]).interpolation;
  assert.equal(score.count,score.hermite.count);
  assert.equal(score.recall,score.hermite.recall);
  assert.equal(score.extended.count,1);
});
