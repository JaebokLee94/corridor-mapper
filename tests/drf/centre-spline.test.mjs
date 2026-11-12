import test from 'node:test';
import assert from 'node:assert/strict';
import {centreSpline} from '../../drf/centre-spline.mjs';
import {createPSPTEvaluator} from '../../drf/pspt-evaluate.mjs';
const patch=(id,x,y=0,phi=0)=>({id,center:[x,y],phi,ell:1,kappa:0,sg:1,status:'supported'});
test('centre Hermite interpolates centres and both tangents; only outer halves survive',()=>{
  const v=.1,a=patch('a',0,0,v),b=patch('b',2,0,Math.PI-v);
  const {links,ends}=centreSpline([a,b]); assert.equal(links.length,1);
  const {points}=links[0];assert.deepEqual(points[0],a.center);assert.deepEqual(points.at(-1),b.center);
  // With equal opposite slopes the vertical coordinate is exactly 2 sin(v) u(1-u).
  for(const [k,[,y]] of points.entries()){const u=k/(points.length-1);assert.ok(Math.abs(y-2*Math.sin(v)*u*(1-u))<1e-13);}
  assert.equal(ends.length,2);assert.ok(ends[0].every(([x])=>x<=0));assert.ok(ends[1].every(([x])=>x>=2));
  for(const cs of [[patch('c',0),patch('d',2,.1),patch('e',2,-.1)],[patch('c',0),patch('f',4.01)],[a,{...b,status:'pending'}]]){
    assert.equal(centreSpline(cs).links.length,0);
  }
});
test('replacing inward halves can remove coverage; truth labels do not choose links',()=>{
  const candidates=[{...patch('a',0),ell:1.5,kappa:1.2},patch('b',3)];
  const measure=walls=>createPSPTEvaluator({walls,truth:[{configs:[{specular:[{s:[1.48,1.3]}],diffuse:[]}]}]})
    .step({t:1,candidates},{diagnostics:{}}).interpolation;
  const e=measure([[[1.45,1.28],[1.5,1.35]]]);
  assert.equal(e.rawMap.recall,1);assert.equal(e.centre.recall,0);
  assert.equal(e.centre.count,1);
  const flat=measure([[[-2,0],[4,0]]]);assert.equal(flat.centre.count,1);assert.equal(flat.centre.falseBridges,0);
});

test('long centre links require evidence for the exact pair and still obey tangent and nearest-side checks',()=>{
  const a=patch('a',0),b=patch('b',5),c=patch('c',2);
  const evidence={from:'b',to:'a',measuredLinear:true};
  assert.equal(centreSpline([a,b],[{...evidence,measuredLinear:false}]).links.length,0);
  assert.equal(centreSpline([a,b],[{...evidence,to:'c'}]).links.length,0);
  assert.equal(centreSpline([a,{...b,phi:Math.PI/6}],[evidence]).links.length,0);
  assert.deepEqual(centreSpline([a,b],[evidence]).links[0].points.filter((_,i,p)=>i===0||i===p.length-1),[a.center,b.center]);
  assert.equal(centreSpline([a,b,c],[evidence]).links.some(l=>l.from==='a'&&l.to==='b'),false);
});
