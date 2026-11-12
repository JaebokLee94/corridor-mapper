// All positions/lengths in metres and phi in radians; no wall labels or truth inputs.
export const CENTRE_RULE = Object.freeze({maxDistanceM:4, maxAngleDeg:15, association:'reciprocal-nearest-per-side', beyondMaxDistance:'range-confirmed-pair-only', curve:'centre-tangent-hermite-v2'});
const cosine = Math.cos(CENTRE_RULE.maxAngleDeg*Math.PI/180), step = .05;

export function patchPoints(c, start=-c.ell, end=c.ell) {
  const tx=Math.cos(c.phi), ty=Math.sin(c.phi);
  const n=Math.max(1,Math.ceil(Math.abs(end-start)*Math.hypot(1,c.kappa*c.ell)/step));
  return Array.from({length:n+1},(_,k)=>{
    const u=k===n?end:start+(end-start)*k/n, bend=.5*c.kappa*c.sg*u*u;
    return [c.center[0]+u*tx-bend*ty,c.center[1]+u*ty+bend*tx];
  });
}

// Input endpoints in metres, oriented unit tangents; endpoint derivatives have chord length.
export function hermitePoints(p,q,d,ta,tb) {
  const dx=q[0]-p[0],dy=q[1]-p[1],ax=d*ta[0],ay=d*ta[1],bx=d*tb[0],by=d*tb[1];
  const steps=Math.max(1,Math.ceil(Math.max(d,Math.hypot(3*dx-ax-bx,3*dy-ay-by))/step));
  return Array.from({length:steps+1},(_,k)=>{
    if(k===0)return p;
    if(k===steps)return q;
    const u=k/steps,v=1-u,w=u*u*(3-2*u);
    return [p[0]+w*dx+u*v*(v*ax-u*bx),p[1]+w*dy+u*v*(v*ay-u*by)];
  });
}

// N current supported fragments -> links and retained ends, O(N² + vertices) time,
// O(N + vertices) space. Each side accepts only a unique, mutual nearest centre.
export function centreSpline(candidates, bridges=[], extensions=[]) {
  // A long pair can compete only when its gap was confirmed from past measured ranges.
  const key=(a,b)=>a<b?a+':'+b:b+':'+a;
  const confirmed=new Set(bridges.filter(b=>b.measuredLinear).map(b=>key(b.from,b.to)));
  const nodes=candidates.filter(c=>c.status==='supported').map(c=>({c,x:Math.cos(c.phi),y:Math.sin(c.phi),
    sides:[0,1].map(()=>({first:Infinity,second:Infinity,partner:-1,used:false}))}));
  const offer=(side,d,j)=>{
    if(d<side.first){side.second=side.first;side.first=d;side.partner=j;}
    else if(d<side.second)side.second=d;
  };
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
    const a=nodes[i], b=nodes[j], dx=b.c.center[0]-a.c.center[0], dy=b.c.center[1]-a.c.center[1];
    const d=Math.hypot(dx,dy), u=dx*a.x+dy*a.y, v=dx*b.x+dy*b.y;
    if(d<=1e-9 || (d>CENTRE_RULE.maxDistanceM && !confirmed.has(key(a.c.id,b.c.id))) || Math.min(Math.abs(u),Math.abs(v))<d*cosine || Math.abs(a.x*b.x+a.y*b.y)<cosine)continue;
    offer(a.sides[Number(u>0)],d,j); offer(b.sides[Number(v<0)],d,i);
  }
  const links=[], ends=[];
  for(const [i,a] of nodes.entries())for(const [s,side] of a.sides.entries()){
    const j=side.partner;
    if(j<=i || side.second-side.first<=1e-9)continue;
    const b=nodes[j], t=b.sides.findIndex(r=>r.partner===i && r.second-r.first>1e-9);
    if(t<0)continue;
    side.used=b.sides[t].used=true;
    const p=a.c.center,q=b.c.center, d=side.first;
    const points=hermitePoints(p,q,d,[(2*s-1)*a.x,(2*s-1)*a.y],[(1-2*t)*b.x,(1-2*t)*b.y]);
    links.push({from:a.c.id,to:b.c.id,points});
  }
  if(extensions.length) {
    const byId=new Map(nodes.map(n=>[n.c.id,n]));
    for(const {from,to,points} of extensions) {
      const a=byId.get(from),b=byId.get(to);
      if(!a || !b || !points?.length)continue;
      const dx=b.c.center[0]-a.c.center[0],dy=b.c.center[1]-a.c.center[1];
      const as=a.sides[Number(dx*a.x+dy*a.y>0)],bs=b.sides[Number(dx*b.x+dy*b.y<0)];
      if(as.used || bs.used)continue;
      as.used=bs.used=true;links.push({from,to,points});
    }
  }
  for(const {c,sides:[left,right]} of nodes) {
    if(!left.used || !right.used)ends.push(patchPoints(c,left.used?0:-c.ell,right.used?0:c.ell));
  }
  return {links,ends};
}
