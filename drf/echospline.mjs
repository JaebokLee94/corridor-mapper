/** EchoSpline (method 5). Fit a single-valued wall to measured bistatic ranges.
 * Inputs: successive measured snapshots (pair IDs, two positions [m], ranges [m]).
 * Output: separate polylines in metres, restricted to 8 m from inverse support.
 * No labels, future snapshots, field pixels or trained weights enter the fit.
 * For M nonempty pair/snapshots, N horizontal samples and K spline coefficients,
 * each fit iteration scans O(MN) distances, plus echo assignment and a banded solve.
 */
import { exactMedian } from './order-statistic.mjs';
import { minimumAssignment } from './range-assignment.mjs';
const clip=(x,a,b)=>Math.min(b,Math.max(a,x));
const zeros=n=>new Float64Array(n);

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
function basis(u,knots,n,spacing,out={idx:0,w:[1,0,0,0]},left=[],right=[]){
  let span=Math.min(n-1,3+Math.floor((u-knots[0])/spacing));span=Math.max(3,span);
  const w=out.w;w[0]=1;
  for(let j=1;j<=3;j++){
    left[j]=u-knots[span+1-j];right[j]=knots[span+j]-u;let saved=0;
    for(let r=0;r<j;r++){const v=w[r]/(right[r+1]+left[j-r]);w[r]=saved+right[r+1]*v;saved=left[j-r]*v;}
    w[j]=saved;
  }out.idx=span-3;return out;
}
const value=(c,{idx,w})=>0+w[0]*c[idx]+w[1]*c[idx+1]+w[2]*c[idx+2]+w[3]*c[idx+3];
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
function inversePoint(p,r,rate,sign,straight,limits,referenceFit){
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
      let a0=lo,b0=hi,lastMid=lo;
      for(let k=0;k<(straight?18:30);k++){const m=(a0+b0)/2;lastMid=m;if((sample(m)<0)===(fl<0))a0=m;else b0=m;}
      const p=sample(referenceFit && straight?lastMid:(a0+b0)/2,true);if(p)roots.push(p);
    }lo=hi;fl=fh;
  }return roots;
}
function initialise(points,x){
  const p=points.sort((a,b)=>a[0]-b[0]),near=zeros(x.length),y=zeros(x.length);
  let lo=0,hi=0,closest=0;
  for(let j=0;j<x.length;j++){
    const q=x[j];while(lo<p.length&&p[lo][0]<q-3)lo++;while(hi<p.length&&p[hi][0]<=q+3)hi++;
    while(closest+1<p.length&&Math.abs(p[closest+1][0]-q)<Math.abs(p[closest][0]-q))closest++;
    near[j]=Math.abs(q-p[closest][0]);
    if(hi-lo>=2){
      const projected=new Float64Array(hi-lo);
      for(let i=lo;i<hi;i++){const [px,py,s]=p[i];projected[i-lo]=py+(q-px)*s;}
      y[j]=exactMedian(projected);
    }else{
      const local=p.slice(Math.max(0,closest-5),closest+6).sort((a,b)=>Math.abs(a[0]-q)-Math.abs(b[0]-q)).slice(0,5);
      y[j]=exactMedian(local.map(([px,py,s])=>py+(q-px)*clip(s,-1.5,1.5)));
    }
  }return {y,near};
}
// Pairs that share an observed position also share its one-way distances for this wall.
function rayDistances(ray,heights){
  if(ray.heights!==heights){
    const {xx,y,d}=ray;
    for(let j=0;j<d.length;j++)d[j]=Math.sqrt(xx[j]+(heights[j]-y)**2);
    ray.heights=heights;
  }
  return ray.d;
}
function* fit(observations,points,sign,grid,details,stationaryCandidates){
  const {x,knots,n,B,spacing,support}=grid,{y,near}=initialise(points,x),prior=zeros(n*4),rhs=zeros(n);
  for(let j=0;j<x.length;j++){
    const {idx,w}=B[j],weight=1/(1+(near[j]/2)**2);outer(prior,idx,w,weight);
    for(let k=0;k<4;k++)rhs[idx+k]+=w[k]*weight*y[j];
  }
  const reg=zeros(4*n),nr=observations.reduce((s,o)=>s+o.rs.length,0),strength=.2*Math.max(nr/300,1);
  for(let j=0;j<n;j++){prior[j*4]+=1e-8;reg[j*4]=strength;}
  for(let j=0;j<n-2;j++){outer(prior,j,[1,-2,1],.1);outer(reg,j,[1,-2,1],strength*.5);}
  const pin=solve(prior,rhs,n);let coef=pin;
  const hitGrid=new Int32Array(x.length),hitOffset=zeros(x.length),hitRange=zeros(x.length),order=[];
  const usedHit=new Uint8Array(x.length),usedEcho=new Uint8Array(observations.reduce((m,o)=>Math.max(m,o.rs.length),0));
  const unmatchedLoss=Math.sqrt(37)-1;
  const pairIds=[],pairE=[],pairI=[],pairK=[];
  const samples=()=>({oi:new Uint32Array(nr),j:new Uint32Array(nr),h:zeros(nr),e:zeros(nr),weight:zeros(nr)});
  const rows=[samples(),samples()];
  function geometry(oi,j,h,heights){
    const {a,b,rayA,rayB}=observations[oi],k=j+(h>0?1:-1);
    const aj=heights[j]-a[1],bj=heights[j]-b[1],ak=heights[k]-a[1],bk=heights[k]-b[1];
    const g=aj/Math.max(1e-8,Math.sqrt(rayA.xx[j]+aj**2))+bj/Math.max(1e-8,Math.sqrt(rayB.xx[j]+bj**2));
    const next=ak/Math.max(1e-8,Math.sqrt(rayA.xx[k]+ak**2))+bk/Math.max(1e-8,Math.sqrt(rayB.xx[k]+bk**2));
    return g+Math.abs(h)*(next-g);
  }
  const scratch={idx:0,w:[1,0,0,0]},left=[],right=[];
  const candidates=stationaryCandidates?.(x,observations,sign),words=Math.ceil(x.length/32);
  function sample(c){
    const heights=zeros(B.length);
    for(let i=0;i<B.length;i++)heights[i]=value(c,B[i]);
    return heights;
  }
  function* evaluate(c,slot,heights=sample(c),prefetched){
    const matchedRows=rows[slot];
    let dataLoss=0,count=0;
    const bits=prefetched!==undefined?prefetched:candidates?yield candidates(heights):null;
    for(let oi=0;oi<observations.length;oi++){
      const {a,b,rs,rayA,rayB}=observations[oi],xxA=rayA.xx,xxB=rayB.xx;
      const minY=Math.max(sign*a[1],sign*b[1]);let nHits=0;
      function refine(j,center,d0,d1){
        if(Math.abs(d1-d0)<1e-12||sign*heights[j]<minY)return;
        const h=clip(-.5*(d0+d1)/(d1-d0),-.5,.5);
        const at=nHits++;
        hitGrid[at]=j;hitOffset[at]=h;hitRange[at]=center+.25*(d0+d1)*h;order[at]=at;
      }
      if(bits){
        const lengthAt=j=>Math.sqrt(xxA[j]+(heights[j]-a[1])**2)+Math.sqrt(xxB[j]+(heights[j]-b[1])**2);
        for(let w=0;w<words;w++){
          let mask=bits[oi*words+w];
          while(mask){
            const j=w*32+31-Math.clz32(mask&-mask);mask&=mask-1;
            if(j>0&&j<x.length-1){
              const center=lengthAt(j),d0=center-lengthAt(j-1),d1=lengthAt(j+1)-center;
              if(d0*d1<=0)refine(j,center,d0,d1);
            }
          }
        }
      }else{
        const da=rayDistances(rayA,heights),db=rayDistances(rayB,heights);
        let center=da[1]+db[1],d0=center-(da[0]+db[0]);
        for(let j=1;j<x.length-1;j++){
          const right=da[j+1]+db[j+1],d1=right-center;
          if(d0*d1<=0)refine(j,center,d0,d1);
          center=right;d0=d1;
        }
      }
      order.length=nHits;
      order.sort((a,b)=>hitRange[a]-hitRange[b]);
      let resolved=0;
      for(const id of order){
        if(!resolved||hitRange[id]-hitRange[order[resolved-1]]>=.6)order[resolved++]=id;
      }
      let numPairs=0;
      for(let i=0;i<rs.length;i++){
        for(let k=0;k<resolved;k++){
          const e=hitRange[order[k]]-rs[i];
          if(e>=1.5)break;
          if(e> -1.5){
            pairIds[numPairs]=numPairs;pairE[numPairs]=e;pairI[numPairs]=i;pairK[numPairs]=k;numPairs++;
          }
        }
      }
      pairIds.length=numPairs;
      // Ties use the original enumeration order: measured echo first, then resolved hit.
      if(numPairs>1)pairIds.sort((a,b)=>Math.abs(pairE[a])-Math.abs(pairE[b])||a-b);
      usedEcho.fill(0,0,rs.length);usedHit.fill(0,0,resolved);
      let matched=0;
      for(const p of pairIds){
        const i=pairI[p],k=pairK[p],e=pairE[p];
        if(usedEcho[i]||usedHit[k])continue;
        usedEcho[i]=1;usedHit[k]=1;matched++;
        const id=order[k], j=hitGrid[id],h=hitOffset[id];
        const divisor=Math.hypot(1,e/.25);
        matchedRows.oi[count]=oi;matchedRows.j[count]=j;matchedRows.h[count]=h;
        matchedRows.e[count]=e;matchedRows.weight[count]=1/divisor;count++;
        dataLoss+=.0625*(divisor-1);
      }
      dataLoss+=(rs.length-matched)*.0625*unmatchedLoss;

    }
    const diff=c.map((v,j)=>v-pin[j]),rd=mul(reg,diff);
    return {heights,slot,count,dataLoss,rd,loss:dataLoss+.5*diff.reduce((s,v,i)=>s+v*rd[i],0)};
  }
  let state=yield* evaluate(coef,0);
  for(let it=0;it<10&&state.count;it++){
    const H=reg.slice(),h=state.rd.map(v=>-v);
    const selected=rows[state.slot];
    for(let m=0;m<state.count;m++){
      const j=selected.j[m],offset=selected.h[m],e=selected.e[m];
      const g=geometry(selected.oi[m],j,offset,state.heights),at=x[j]+offset*.2;
      const {idx,w}=basis(at,knots,n,spacing,scratch,left,right);
      const weight=selected.weight[m];outer(H,idx,w,weight*g*g);
      for(let k=0;k<4;k++)h[idx+k]-=weight*g*w[k]*e;
    }
    const delta=solve(H,h,n);let accepted=false,move=0;
    const steps=[1,.5,.25,.125];
    const trial=step=>coef.map((v,j)=>pin[j]+clip(v+step*delta[j]-pin[j],-2,2));
    const proposals=candidates?.batch?steps.map(trial):null;
    const heights=proposals?.map(sample);
    const masks=proposals?yield candidates.batch(heights):null;
    // Submit independent line-search candidates together but accept in the original order.
    for(let i=0;i<steps.length;i++){
      const c=proposals?.[i]??trial(steps[i]),next=yield* evaluate(c,1-state.slot,heights?.[i],masks?.[i]);
      if(next.loss<=state.loss+1e-12){move=Math.max(...c.map((v,i)=>Math.abs(v-coef[i])));coef=c;state=next;accepted=true;break;}
    }if(!accepted||move<.002)break;
  }
  let matches;
  if(details){
    const selected=rows[state.slot];
    matches=Array.from({length:state.count},(_,i)=>{
      const j=selected.j[i],h=selected.h[i],at=x[j]+h*.2;
      return {e:selected.e[i],g:geometry(selected.oi[i],j,h,state.heights),x:at,b:basis(at,knots,n,spacing)};
    });
  }
  const curves=[];let run=[];
  for(let j=0;j<x.length;j++){if(near[j]<=support)run.push([x[j],state.heights[j]]);else{if(run.length>=2)curves.push(run);run=[];}}
  if(run.length>=2)curves.push(run);
  return {curves,cost:state.dataLoss/nr,matched:state.count,
    ...(details?{fit:{sign,points,x,prior:y,heights:state.heights,near,matches}}:{})};
}
export class EchoSpline {
  constructor({domain,upper=false,spacing=2,support=8,stationaryCandidates}={}){
    const [lo,hi]=domain??[0,100];this.limits=[lo,hi];this.upper=upper;this.referenceFit=upper;this.pairs=new Map();this.obs=[];this.tracks=[];
    const x=Float64Array.from({length:Math.round((hi-lo)/.2)+1},(_,k)=>lo+k*.2);
    const knots=[lo,lo,lo,lo];for(let k=lo+spacing;k<hi;k+=spacing)knots.push(k);knots.push(hi,hi,hi,hi);
    const n=knots.length-4;this.grid={x,knots,n,spacing,support,stationaryCandidates,B:Array.from(x,u=>basis(u,knots,n,spacing))};this.straight=true;
  }
  observe(wire){
    const rays=new Map(),x=this.grid.x;
    function rayAt(p){
      const key=p[0]+','+p[1];
      if(!rays.has(key))rays.set(key,{xx:x.map(v=>(v-p[0])**2),y:p[1],d:zeros(x.length)});
      return rays.get(key);
    }
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
        p.rayA=rayAt(a);p.rayB=rayAt(b);this.obs.push(p);
      }
      const pred=pair.active.map(tr=>{const last=tr.at(-1).r,n=Math.min(tr.length-1,3);return last+(n?clip((last-tr[tr.length-1-n].r)/n,-1.8,1.8):0);});
      const next=[],used=new Set();
      const matches=this.referenceFit?minimumAssignment(pred.length,rs.length,(i,j)=>Math.abs(pred[i]-rs[j])):match(pred,rs);
      for(const tr of pair.active)tr.closed=true;
      for(const [i,j] of matches)if(Math.abs(pred[i]-rs[j])<=3.25){const tr=pair.active[i];tr.closed=false;tr.push({r:rs[j],p});next.push(tr);used.add(j);}
      rs.forEach((r,j)=>{if(!used.has(j)){const tr=[{r,p}];next.push(tr);this.tracks.push(tr);}});
      pair.active=next;
    }
  }
  step(wire,details=false){this.observe(wire);return this.estimate(details); }
  estimate(details=false){
    const fit=this.estimateMaps(details,this.grid.stationaryCandidates);
    let step=fit.next();
    while(!step.done)step=fit.next(step.value);
    return step.value;
  }
  async estimateAsync(details,gpu){
    const fit=this.estimateMaps(details,(x,obs,sign)=>gpu.bind(x,obs,sign));
    let step=fit.next();
    while(!step.done)step=fit.next(await step.value);
    return step.value;
  }
  *estimateMaps(details,stationaryCandidates){
    let best=null,ambiguous=false;
    const signs=this.upper?[1]:[1,-1],sides=signs.map(()=>[]);
    for(const tr of this.tracks)if(tr.length>=5)for(let j=0;j<tr.length;j++){
      const row=tr[j];
      // A closed track also has fixed edge windows: the following pair frame completed its last velocity.
      let roots=row.straight===this.straight?row.roots:null;
      if(!roots){
        const [r,rate]=smoothed(tr,j);
        roots=signs.map(sign=>inversePoint(row.p,r,rate,sign,this.straight,this.limits,this.referenceFit));
        if(tr.closed || (tr.length>=9&&j+4<tr.length)){row.straight=this.straight;row.roots=roots;}
      }
      for(let i=0;i<sides.length;i++)for(const q of roots[i])sides[i].push(details?q.slice():q);
    }
    for(let i=0;i<signs.length;i++){
      const sign=signs[i],pts=sides[i];
      if(pts.length<5)continue;
      const candidate=yield* fit(this.obs,pts,sign,this.grid,details,stationaryCandidates);
      if(!best||candidate.cost<best.cost-1e-10){best=candidate;ambiguous=false;}
      else if(Math.abs(candidate.cost-best.cost)<=1e-10)ambiguous=true;
    }
    return {...(details && !ambiguous && best?{fit:best.fit}:{}),curves:ambiguous?[]:best?.curves??[],matchedEchoes:best?.matched??0,rangeCount:this.obs.reduce((s,o)=>s+o.rs.length,0),ambiguous};
  }
}
