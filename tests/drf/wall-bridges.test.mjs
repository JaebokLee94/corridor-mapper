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
