/** EchoSpline (method 5). Fit a single-valued wall to measured bistatic ranges.
 * Inputs: successive measured snapshots (pair IDs, two positions [m], ranges [m]).
 * Output: separate polylines in metres, restricted to 8 m from inverse support.
 * No labels, future snapshots, field pixels or trained weights enter the fit.
 * For M nonempty pair/snapshots, N horizontal samples and K spline coefficients,
 * each fit iteration scans O(MN) distances, plus echo assignment and a banded solve.
 */
const clip=(x,a,b)=>Math.min(b,Math.max(a,x));
const zeros=n=>new Float64Array(n);
const median=a=>{a.sort((x,y)=>x-y);const i=a.length>>1;return a.length%2?a[i]:(a[i-1]+a[i])/2;};

// Minimum absolute-distance assignment in 1D: an optimal pairing preserves sorted
// order. Match every element of the smaller list to a subsequence of the larger.
function match(a,b) {
  if(!a.length||!b.length)return [];
  if(a.length>b.length)return match(b,a).map(([j,i])=>[i,j]);
  const ai=a.map((_,i)=>i).sort((i,j)=>a[i]-a[j]),bi=b.map((_,i)=>i).sort((i,j)=>b[i]-b[j]);
  if(a.length===b.length)return ai.map((i,k)=>[i,bi[k]]);
  const n=b.length+1, chosen=new Uint8Array((a.length+1)*n);let prev=zeros(n);
  for(let i=1;i<=a.length;i++){
    const curr=zeros(n);curr.fill(Infinity);
    for(let j=i;j<n;j++){
      const take=prev[j-1]+Math.abs(a[ai[i-1]]-b[bi[j-1]]);
      if(take<=curr[j-1]){curr[j]=take;chosen[i*n+j]=1;}else curr[j]=curr[j-1];
    }prev=curr;
  }
  const out=[];for(let i=a.length,j=b.length;i;j--){if(chosen[i*n+j])out.push([ai[--i],bi[j-1]]);}
  return out;
}

// Positive definite matrix in lower-band storage. Cholesky factor and solves.
function solve(mat,rhs,n,bw=4){
  const l=mat.slice(),x=rhs.slice();
  for(let i=0;i<n;i++)for(let j=Math.max(0,i-bw+1);j<=i;j++){
    let s=l[i*bw+i-j];
    for(let k=Math.max(0,i-bw+1);k<j;k++)s-=l[i*bw+i-k]*l[j*bw+j-k];
    l[i*bw+i-j]=i===j?Math.sqrt(s):s/l[j*bw];
  }
  for(let i=0;i<n;i++){for(let k=1;k<bw&&k<=i;k++)x[i]-=l[i*bw+k]*x[i-k];x[i]/=l[i*bw];}
  for(let i=n-1;i>=0;i--){for(let k=1;k<bw&&i+k<n;k++)x[i]-=l[(i+k)*bw+k]*x[i+k];x[i]/=l[i*bw];}
  return x;
}
function outer(h,idx,w,scale){
  for(let i=0;i<w.length;i++)for(let j=0;j<=i;j++)h[(idx+i)*4+i-j]+=scale*w[i]*w[j];
}
function mul(h,x){
  const y=zeros(x.length);
  for(let i=0;i<x.length;i++){
    y[i]+=h[i*4]*x[i];
    for(let d=1;d<4&&d<=i;d++){const k=h[i*4+d];y[i]+=k*x[i-d];y[i-d]+=k*x[i];}
  }return y;
}
function basis(u,knots,n,spacing){
  let span=Math.min(n-1,3+Math.floor((u-knots[0])/spacing));span=Math.max(3,span);
  const w=[1,0,0,0],left=[],right=[];
  for(let j=1;j<=3;j++){
    left[j]=u-knots[span+1-j];right[j]=knots[span+j]-u;let saved=0;
    for(let r=0;r<j;r++){const v=w[r]/(right[r+1]+left[j-r]);w[r]=saved+right[r+1]*v;saved=left[j-r]*v;}
    w[j]=saved;
  }return {idx:span-3,w};
}
const value=(c,b)=>b.w.reduce((v,w,k)=>v+w*c[b.idx+k],0);
const sgCache=new Map();
function smoothed(track,k){
  const n=track.length,w=Math.min(9,n%2?n:n-1),start=clip(k-(w>>1),0,n-w),at=k-start,key=w*10+at;
  let weights=sgCache.get(key);
  if(!weights){
    const h=zeros(9);
    for(let i=0;i<w;i++){const t=i-at,a=[1,t,t*t];for(let j=0;j<3;j++)for(let l=0;l<=j;l++)h[j*3+j-l]+=a[j]*a[l];}
    weights=[[1,0,0],[0,1,0]].map(rhs=>{const c=solve(h,rhs,3,3);return Array.from({length:w},(_,i)=>c[0]+(i-at)*(c[1]+(i-at)*c[2]));});
    sgCache.set(key,weights);
  }
  return weights.map(row=>row.reduce((sum,w,i)=>sum+w*track[start+i].r,0));
}
function inversePoint(p,r,rate,sign,straight,limits){
  const {a,b,va,vb}=p,bx=b[0]-a[0],by=sign*(b[1]-a[1]),s=r*r-bx*bx-by*by;
  if(!(s>.01&&r>0&&Math.abs(rate)<.975*(Math.hypot(...va)+Math.hypot(...vb))))return [];
  const midX=(a[0]+b[0])/2,midY=sign*(a[1]+b[1])/2;
  function sample(t,point=false){
    const sn=Math.sin(t),cs=Math.cos(t),bn=bx*sn+by*cs,root=Math.sqrt(s+bn*bn);
    if(straight&&!point)return 2*sn*root+r*rate;
    const x=midX+(s*sn+bx*bn)/(2*root),y=midY+(s*cs+by*bn)/(2*root);
    if(point)return (cs>.3&&x>=limits[0]-5&&x<=limits[1]+5&&y>=Math.max(sign*a[1],sign*b[1])-.4)?[x,sign*y,-sign*sn/cs]:null;
    const dx=x-a[0],dy=y-sign*a[1],ex=x-b[0],ey=y-sign*b[1];
    return -(dx*va[0]+dy*sign*va[1])/Math.max(1e-12,Math.hypot(dx,dy))-(ex*vb[0]+ey*sign*vb[1])/Math.max(1e-12,Math.hypot(ex,ey))-rate;
  }
  const edge=Math.PI/2-.001,steps=straight?1:63,roots=[];let lo=-edge,fl=sample(lo);
  for(let j=1;j<=steps;j++){
    const hi=-edge+2*edge*j/steps,fh=sample(hi);
    if((fl<=0&&fh>=0)||(fl>=0&&fh<=0)){
      let a0=lo,b0=hi;
      for(let k=0;k<(straight?18:30);k++){const m=(a0+b0)/2;if((sample(m)<0)===(fl<0))a0=m;else b0=m;}
      const p=sample((a0+b0)/2,true);if(p)roots.push(p);
    }lo=hi;fl=fh;
  }return roots;
}
function initialise(points,x){
  const p=points.sort((a,b)=>a[0]-b[0]),near=zeros(x.length),y=zeros(x.length);
  let lo=0,hi=0,closest=0;
  for(let j=0;j<x.length;j++){
    const q=x[j];while(lo<p.length&&p[lo][0]<q-3)lo++;while(hi<p.length&&p[hi][0]<=q+3)hi++;
    while(closest+1<p.length&&Math.abs(p[closest+1][0]-q)<Math.abs(p[closest][0]-q))closest++;
    near[j]=Math.abs(q-p[closest][0]);let local;
    if(hi-lo>=2)local=p.slice(lo,hi);
    else local=p.slice(Math.max(0,closest-5),closest+6).sort((a,b)=>Math.abs(a[0]-q)-Math.abs(b[0]-q)).slice(0,5);
    y[j]=median(local.map(([px,py,s])=>py+(q-px)*clip(s,hi-lo>=2?-Infinity:-1.5,hi-lo>=2?Infinity:1.5)));
  }return {y,near};
}
function fit(observations,points,sign,grid){
  const {x,knots,n,B,spacing,support}=grid,{y,near}=initialise(points,x),prior=zeros(n*4),rhs=zeros(n);
  for(let j=0;j<x.length;j++){
    const {idx,w}=B[j],weight=1/(1+(near[j]/2)**2);outer(prior,idx,w,weight);
    for(let k=0;k<4;k++)rhs[idx+k]+=w[k]*weight*y[j];
  }
  const reg=zeros(4*n),nr=observations.reduce((s,o)=>s+o.rs.length,0),strength=.2*Math.max(nr/300,1);
  for(let j=0;j<n;j++){prior[j*4]+=1e-8;reg[j*4]=strength;}
  for(let j=0;j<n-2;j++){outer(prior,j,[1,-2,1],.1);outer(reg,j,[1,-2,1],strength*.5);}
  const pin=solve(prior,rhs,n),L=zeros(x.length);let coef=pin;
  function evaluate(c){
    const heights=Float64Array.from(B,b=>value(c,b)),matches=[];
    let dataLoss=0;
    for(const o of observations){
      const {a,b,rs,xxA,xxB}=o;const minY=Math.max(sign*a[1],sign*b[1]);const hits=[];
      for(let j=0;j<x.length;j++){const y=heights[j];L[j]=Math.sqrt(xxA[j]+(y-a[1])**2)+Math.sqrt(xxB[j]+(y-b[1])**2);}
      for(let j=1;j<x.length-1;j++){
        const d0=L[j]-L[j-1],d1=L[j+1]-L[j];if(d0*d1>0||Math.abs(d1-d0)<1e-12||sign*heights[j]<minY)continue;
        const h=clip(-.5*(d0+d1)/(d1-d0),-.5,.5);
        const deriv=k=>(heights[k]-a[1])/Math.max(1e-8,Math.sqrt(xxA[k]+(heights[k]-a[1])**2))+(heights[k]-b[1])/Math.max(1e-8,Math.sqrt(xxB[k]+(heights[k]-b[1])**2));
        const g=deriv(j);
        hits.push({x:x[j]+h*.2,r:L[j]+.25*(d0+d1)*h,g:g+Math.abs(h)*(deriv(j+(h>0?1:-1))-g)});
      }
      hits.sort((a,b)=>a.r-b.r);const resolved=[];for(const h of hits)if(!resolved.length||h.r-resolved.at(-1).r>=.6)resolved.push(h);
      const pairs=[];
      rs.forEach((r,i)=>resolved.forEach((h,k)=>{const e=h.r-r;if(Math.abs(e)<1.5)pairs.push({i,k,e});}));
      pairs.sort((a,b)=>Math.abs(a.e)-Math.abs(b.e)||a.i-b.i||a.k-b.k);
      const used=new Set(),usedHit=new Set();
      for(const {i,k,e} of pairs){if(used.has(i)||usedHit.has(k))continue;used.add(i);usedHit.add(k);const h=resolved[k];
        matches.push({e,g:h.g,b:basis(h.x,knots,n,spacing)});dataLoss+=.0625*(Math.hypot(1,e/.25)-1);}
      dataLoss+=(rs.length-used.size)*.0625*(Math.sqrt(37)-1);
    }
    const diff=c.map((v,j)=>v-pin[j]),rd=mul(reg,diff);
    return {heights,matches,dataLoss,rd,loss:dataLoss+.5*diff.reduce((s,v,i)=>s+v*rd[i],0)};
  }
  let state=evaluate(coef);
  for(let it=0;it<10&&state.matches.length;it++){
    const H=reg.slice(),h=state.rd.map(v=>-v);
    for(const {e,g,b:{idx,w}} of state.matches){
      const weight=1/Math.hypot(1,e/.25);outer(H,idx,w,weight*g*g);
      for(let k=0;k<4;k++)h[idx+k]-=weight*g*w[k]*e;
    }
    const delta=solve(H,h,n);let accepted=false,move=0;
    for(const step of [1,.5,.25,.125]){
      const c=coef.map((v,j)=>pin[j]+clip(v+step*delta[j]-pin[j],-2,2)),next=evaluate(c);
      if(next.loss<=state.loss+1e-12){move=Math.max(...c.map((v,i)=>Math.abs(v-coef[i])));coef=c;state=next;accepted=true;break;}
    }if(!accepted||move<.002)break;
  }
  const curves=[];let run=[];
  for(let j=0;j<x.length;j++){if(near[j]<=support)run.push([x[j],state.heights[j]]);else{if(run.length>=2)curves.push(run);run=[];}}
  if(run.length>=2)curves.push(run);
  return {curves,cost:state.dataLoss/nr,matched:state.matches.length};
}
export class EchoSpline {
  constructor({domain,upper=false,spacing=2,support=8}={}){
    const [lo,hi]=domain??[0,100];this.limits=[lo,hi];this.upper=upper;this.pairs=new Map();this.obs=[];this.tracks=[];
    const x=Float64Array.from({length:Math.round((hi-lo)/.2)+1},(_,k)=>lo+k*.2);
    const knots=[lo,lo,lo,lo];for(let k=lo+spacing;k<hi;k+=spacing)knots.push(k);knots.push(hi,hi,hi,hi);
    const n=knots.length-4;this.grid={x,knots,n,spacing,support,B:Array.from(x,u=>basis(u,knots,n,spacing))};this.straight=true;
  }
  observe(wire){
    for(const c of wire.configs){
      const key=c.i+','+c.j,rs=c.paths.map(p=>p.dHat),a=c.pHat_i,b=c.pHat_j;
      if(!this.pairs.has(key))this.pairs.set(key,{frames:[],active:[]});
      const pair=this.pairs.get(key),frames=pair.frames,prev=frames.at(-1),p={a,b,rs,va:[0,0],vb:[0,0]};
      if(prev){
        for(const [pos,vel] of [['a','va'],['b','vb']]){
          p[vel]=p[pos].map((v,i)=>v-prev[pos][i]);if(Math.abs(p[vel][0]-1)>1e-9||Math.abs(p[vel][1])>1e-9)this.straight=false;
          prev[vel]=frames.length<2?p[vel]:p[pos].map((v,i)=>(v-frames.at(-2)[pos][i])/2);
        }
      }
      frames.push(p);
      if(rs.length){
        const x=this.grid.x;p.xxA=x.map(v=>(v-a[0])**2);p.xxB=x.map(v=>(v-b[0])**2);this.obs.push(p);
      }
      const pred=pair.active.map(tr=>{const last=tr.at(-1).r,n=Math.min(tr.length-1,3);return last+(n?clip((last-tr[tr.length-1-n].r)/n,-1.8,1.8):0);});
      const next=[],used=new Set();
      for(const [i,j] of match(pred,rs))if(Math.abs(pred[i]-rs[j])<=3.25){const tr=pair.active[i];tr.push({r:rs[j],p});next.push(tr);used.add(j);}
      rs.forEach((r,j)=>{if(!used.has(j)){const tr=[{r,p}];next.push(tr);this.tracks.push(tr);}});pair.active=next;
    }
  }
  step(wire){this.observe(wire);return this.estimate();}
  estimate(){
    let best=null,ambiguous=false;
    for(const sign of this.upper?[1]:[1,-1]){
      const pts=[];
      for(const tr of this.tracks)if(tr.length>=5)for(let j=0;j<tr.length;j++){
        const [r,rate]=smoothed(tr,j);for(const q of inversePoint(tr[j].p,r,rate,sign,this.straight,this.limits))pts.push(q);
      }
      if(pts.length<5)continue;
      const candidate=fit(this.obs,pts,sign,this.grid);
      if(!best||candidate.cost<best.cost-1e-10){best=candidate;ambiguous=false;}
      else if(Math.abs(candidate.cost-best.cost)<=1e-10)ambiguous=true;
    }
    return {curves:ambiguous?[]:best?.curves??[],matchedEchoes:best?.matched??0,rangeCount:this.obs.reduce((s,o)=>s+o.rs.length,0),ambiguous};
  }
}
