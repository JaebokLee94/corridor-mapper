// The frozen regressor uses 26 inverse-point descriptors and 24 fit descriptors
// at each x (metres). Only points, matches and heights from this measured prefix enter.
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const sort=a=>a.sort((x,y)=>x-y);
function quantile(sorted,q){
  const i=(sorted.length-1)*q,k=Math.floor(i);
  return sorted[k]+(i-k)*(sorted[Math.min(k+1,sorted.length-1)]-sorted[k]);
}
function descriptors(points,x,links){
  const rows=[],base=[],middle=quantile(points.map(p=>p[0]),.5);let cut=0;
  for(const q of x){
    while(cut<points.length&&points[cut][0]<q)cut++;
    let lo=cut-1,hi=cut;const ids=[];
    for(let i=0;i<Math.min(6,points.length);i++){
      if(hi===points.length||lo>=0&&q-points[lo][0]<=points[hi][0]-q)ids.push(lo--);else ids.push(hi++);
    }
    const closest=Math.abs(points[ids[0]][0]-q);
    function local(rad){
      let a=cut,b=cut;while(a>0&&points[a-1][0]>=q-rad)a--;while(b<points.length&&points[b][0]<=q+rad)b++;
      return points.slice(a,b);
    }
    const near=local(3),project=p=>p[1]+clamp(p[2],-2,2)*(q-p[0]);
    const b=quantile(sort((near.length>=2?near:ids.map(i=>points[i])).map(project)),.5);base.push(b);
    const row=[closest,clamp(q-middle,-20,20),quantile(sort(ids.map(i=>points[i][2])),.5)];
    for(const rad of [2,5,10]){
      const kept=local(Math.max(rad,closest+1)),ys=sort(kept.map(p=>project(p)-b));
      row.push(...[.15,.5,.85].map(p=>quantile(ys,p)),kept.length/links,quantile(sort(kept.map(p=>p[2])),.5));
    }
    rows.push(row);
  }
  rows.forEach((row,i)=>{for(const d of [1,4,12,24])row.push(base[Math.max(0,i-d)]-base[i],base[Math.min(i+d,base.length-1)]-base[i]);});
  return rows;
}
function gradient(a){
  return a.map((v,i)=>(a[Math.min(a.length-1,i+1)]-a[Math.max(0,i-1)])/(i===0||i===a.length-1?.2:.4));
}
export function correctFit({points,x,prior,heights,near,matches},model,links,support){
  const start=x[0],coarse=Array.from({length:Math.round((x.at(-1)-start)/.5)+1},(_,i)=>start+i*.5);
  const rows=descriptors(points,coarse,links),dy=gradient(heights),ddy=gradient(dy),curves=[];
  const ordered=[...matches].sort((a,b)=>a.x-b.x),bounds=[[0,0],[0,0],[0,0]];
  let line=[];
  for(let i=0;i<x.length;i++){
    if(near[i]>support){if(line.length>1)curves.push(line);line=[];continue;}
    const q=x[i],idx=clamp((q-start)*2,0,rows.length-1),k=Math.floor(idx),f=idx-k;
    const features=rows[k].map((v,j)=>v+f*(rows[Math.min(k+1,rows.length-1)][j]-v));
    features.push(heights[i]-prior[i],dy[i],ddy[i]);
    for(const d of [3,10,20])features.push(heights[Math.max(0,i-d)]-heights[i],heights[Math.min(i+d,x.length-1)]-heights[i]);
    [1,3,8].forEach((r,j)=>{
      const range=bounds[j];while(range[0]<ordered.length&&ordered[range[0]].x<q-r)range[0]++;
      while(range[1]<ordered.length&&ordered[range[1]].x<=q+r)range[1]++;
      const n=range[1]-range[0];let se=0,sa=0,sg=0,seg=0,sgg=0;
      for(let z=range[0];z<range[1];z++){const {e,g}=ordered[z];se+=e;sa+=Math.abs(e);sg+=g;seg+=e*g;sgg+=g*g;}
      features.push(n/links,se/(n||1),sa/(n||1),sg/(n||1),seg/(sgg+.1));
    });
    const target=Float32Array.from(features);let delta=model.base;
    for(const tree of model.trees){let node=tree[0];while(node.length>1)node=tree[target[node[0]]<=node[1]?node[2]:node[3]];delta+=node[0];}
    line.push([q,heights[i]+model.shrink*delta]);
  }
  if(line.length>1)curves.push(line);return curves;
}
