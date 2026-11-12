import { centreSpline, hermitePoints, patchPoints } from './centre-spline.mjs';
import { BRIDGE_RULE } from './wall-bridges.mjs?v=20261112-chain-tips';

const distance=(p,q)=>Math.hypot(p[0]-q[0],p[1]-q[1]);
const dot=(v,w)=>v[0]*w[0]+v[1]*w[1];
const cosLimit=Math.cos(BRIDGE_RULE.extendedMaxAngleDeg*Math.PI/180);
export const CHECKED_CENTRE_RULE=Object.freeze({maxCellM:0.5, binPaddingM:0, curve:'range-checked-centre-or-retained-halves-v2', chainTip:'nearest-free-end-of-one-existing-chain', chainFineMinLooks:[4,4,3], chainFineTotalLooks:12, chainCoarseCellM:1});

// Subdivide each proposed section by arc length. The measurement test runs on
// its local chords, with no padding that could borrow support from outside a cell.
function sectionSupported(points, first, last, evidence, cellM=CHECKED_CENTRE_RULE.maxCellM, mode=true) {
  const arc=[0];
  for(let i=1;i<points.length;i++)arc.push(arc[i-1]+distance(points[i],points[i-1]));
  const start=arc[first],length=arc[last]-start;
  if(length<=0)return false;
  const count=Math.max(2,Math.ceil(length/cellM));let j=first,prev=points[first];
  for(let i=1;i<=count;i++) {
    const s=start+length*i/count;
    while(j<points.length-2 && arc[j+1]<s)j++;
    const weight=(s-arc[j])/(arc[j+1]-arc[j]);
    const q=points[j].map((x,k)=>x+weight*(points[j+1][k]-x));
    if(!evidence.confirms([prev,q],mode))return false;
    prev=q;
  }
  return true;
}

function tipFrame(node,side) {
  const {c,t}=node, slope=c.kappa*c.sg*side*c.ell,scale=side/Math.hypot(1,slope);
  return [scale*(t[0]-slope*t[1]),scale*(t[1]+slope*t[0])];
}

function checkedCurve(a,b,sa,sb,tips,evidence) {
  const p=a.c.center,q=b.c.center;
  const curve=hermitePoints(p,q,distance(p,q),a.t.map(x=>sa*x),b.t.map(x=>-sb*x));
  const closest=tip=>curve.reduce((best,pt,i)=>distance(pt,tip)<distance(curve[best],tip)?i:best,0);
  const i=closest(tips[0]), j=closest(tips[1]);
  if(sectionSupported(curve,0,i,evidence) && sectionSupported(curve,i,j,evidence) &&
     sectionSupported(curve,j,curve.length-1,evidence))return curve;
  return fillTips(a,b,sa,sb,tips,evidence,false);
}

function fillTips(a,b,sa,sb,tips,evidence,chain) {
  const gap=hermitePoints(tips[0],tips[1],distance(...tips),tipFrame(a,sa),tipFrame(b,sb).map(x=>-x));
  if(!sectionSupported(gap,0,gap.length-1,evidence,.5,chain?'pooled':true))return null;
  if(chain && !sectionSupported(gap,0,gap.length-1,evidence,1,true))return null;
  return [...patchPoints(a.c,0,sa*a.c.ell).slice(0,-1),...gap,...patchPoints(b.c,sb*b.c.ell,0).slice(1)];
}

// Current supported centres and uniquely paired tips in metres. Store only accepted
// extension paths on their owning bridges. No scene, labels or future frames enter.
// O(N² + E + tested cells × past snapshots × pairs × log echoes); stable cells reuse evidence.
export function markCentreExtensions(candidates, ordinary, extended, evidence) {
  const nodes=new Map(candidates.filter(c=>c.status==='supported').map(c=>[c.id,{
    c,t:[Math.cos(c.phi),Math.sin(c.phi)],used:new Set()
  }]));
  const side=(n,p)=>Math.sign((p[0]-n.c.center[0])*n.t[0]+(p[1]-n.c.center[1])*n.t[1]);
  for(const {from,to} of centreSpline(candidates,ordinary).links) {
    const a=nodes.get(from),b=nodes.get(to);
    a.used.add(side(a,b.c.center)); b.used.add(side(b,a.c.center));
  }
  const pool=[],degree=new Map();
  for(const bridge of [...ordinary,...extended]) {
    const a=nodes.get(bridge.from),b=nodes.get(bridge.to),p=a.c.center,q=b.c.center;
    const d=distance(p,q),sa=side(a,q),sb=side(b,p);
    if(!d || a.used.has(sa) || b.used.has(sb) || side(a,bridge.points[0])!==sa || side(b,bridge.points[1])!==sb)continue;
    const u=[(q[0]-p[0])/d,(q[1]-p[1])/d];
    if(Math.min(sa*dot(a.t,u),-sb*dot(b.t,u),-sa*sb*dot(a.t,b.t))<cosLimit)continue;
    const keys=[bridge.from+'/'+sa,bridge.to+'/'+sb];
    for(const key of keys)degree.set(key,(degree.get(key)??0)+1);
    pool.push({a,b,sa,sb,keys,bridge});
  }
  for(const {a,b,sa,sb,keys,bridge} of pool) {
    if(keys.some(k=>degree.get(k)!==1))continue;
    const points=checkedCurve(a,b,sa,sb,bridge.points,evidence);
    if(points)bridge.checkedCentrePoints=points;
  }
}

export function confirmedExtensions(bridges,extras) {
  return [...bridges,...extras].filter(b=>b.checkedCentrePoints).map(b=>({from:b.from,to:b.to,points:b.checkedCentrePoints}));
}

// Resolve ambiguity only when every farther alternative is an occupied side of the
// same existing chain as the nearer free tip. Two competing free ends stay ambiguous.
export function checkedChainTips(candidates, current, ambiguous, evidence) {
  if(!ambiguous?.length)return [];
  const nodes=new Map(candidates.filter(c=>c.status==='supported').map(c=>[c.id,{
    c,t:[Math.cos(c.phi),Math.sin(c.phi)],used:new Set(),parent:c.id
  }]));
  const root=n=>{while(n.parent!==n.c.id)n=nodes.get(n.parent);return n;};
  const side=(n,p)=>Math.sign((p[0]-n.c.center[0])*n.t[0]+(p[1]-n.c.center[1])*n.t[1]);
  for(const {from,to} of current.links){
    const a=nodes.get(from),b=nodes.get(to);
    a.used.add(side(a,b.c.center));b.used.add(side(b,a.c.center));root(a).parent=root(b).c.id;
  }
  const choices=new Map(),pairs=[];
  for(const {from,to,points} of ambiguous) {
    const a=nodes.get(from),b=nodes.get(to),sa=side(a,points[0]),sb=side(b,points[1]);
    const ka=from+'/'+sa,kb=to+'/'+sb,gap=distance(...points);
    if(!choices.has(ka))choices.set(ka,[]);
    if(!choices.has(kb))choices.set(kb,[]);
    choices.get(ka).push({n:b,s:sb,gap});choices.get(kb).push({n:a,s:sa,gap});
    pairs.push({a,b,sa,sb,ka,kb,points,gap});
  }
  const result=[];
  const onlyFreeTip=(key,n,s,gap)=>choices.get(key).every(o=>
    (o.n===n && o.s===s) || (o.gap>gap && root(o.n)===root(n) && o.n.used.has(o.s)));
  for(const {a,b,sa,sb,ka,kb,points,gap} of pairs){
    if(a.used.has(sa)||b.used.has(sb)||root(a)===root(b))continue;
    if(sa!==side(a,b.c.center)||sb!==side(b,a.c.center))continue;
    if(!onlyFreeTip(ka,b,sb,gap)||!onlyFreeTip(kb,a,sa,gap))continue;
    const path=fillTips(a,b,sa,sb,points,evidence,true);
    if(path)result.push({from:a.c.id,to:b.c.id,points:path});
  }
  // A second bridge must not close a cycle between previously separate chains.
  return result.sort((l,r)=>distance(l.points[0],l.points.at(-1))-distance(r.points[0],r.points.at(-1))).filter(link=>{
    const a=root(nodes.get(link.from)),b=root(nodes.get(link.to));if(a===b)return false;
    a.parent=b.c.id;return true;
  });
}
