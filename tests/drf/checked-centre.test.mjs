import test from 'node:test';
import assert from 'node:assert/strict';
import { centreSpline } from '../../drf/centre-spline.mjs';
import { markCentreExtensions, confirmedExtensions } from '../../drf/checked-centre.mjs';
import { GapRangeEvidence } from '../../drf/bridge-evidence.mjs';
const patch=(id,x,phi)=>({id,center:[x,0],phi,status:'supported',ell:1,sg:1,kappa:0});
const cs=[patch('a',0,.05),patch('b',6,-.05)];
const tips=[[Math.cos(.05),Math.sin(.05)],[6-Math.cos(.05),Math.sin(.05)]];
function check(predicate) {
 const extras=[{from:'a',to:'b',points:tips}];
 markCentreExtensions(cs,[],extras,{confirms(points,cell){assert(cell);return predicate(...points);}});
 return confirmedExtensions([],extras);
}
test('unconfirmed interior vetoes a geometrically unique but unobserved gap',()=>{
 assert.deepEqual(check((a,b)=>a[0]>3.3 || b[0]<2.7),[]);
 const links=check(()=>true), map=centreSpline(cs,[],links);
 assert.equal(links.length,1);assert.deepEqual(map.links[0].points[0],cs[0].center);
 assert.deepEqual(map.links[0].points.at(-1),cs[1].center);
});
test('when support ends at the tips, retain both measured half-patches',()=>{
 const links=check((a,b)=>a[0]>tips[0][0]-.001 && b[0]<tips[1][0]+.001);
 assert.equal(links.length,1);
 for(const tip of tips)assert(links[0].points.some(p=>Math.hypot(p[0]-tip[0],p[1]-tip[1])<1e-9));
});
test('strict curve cell only credits specular feet inside the cell in three measured snapshots',()=>{
 const evidence=new GapRangeEvidence(.1);
 // Four symmetric pairs above a flat wall; reflection feet all at x=.25.
 const configs=[.1,.2,.3,.4].map(h=>({pHat_i:[.25-h,2],pHat_j:[.25+h,2],paths:[{dHat:Math.hypot(2*h,4)}]}));
 for(let i=0;i<2;i++){evidence.add({configs});assert.equal(evidence.confirms([[0,0],[.5,0]],true),false);}
 evidence.add({configs});
 assert.equal(evidence.confirms([[0,0],[.5,0]],true),true);
 assert.equal(evidence.confirms([[.26,0],[.76,0]],true),false);
});
