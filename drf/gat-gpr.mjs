// Four consecutive measured echoes per Tx/Rx link form a 12-node graph. The trained
// network predicts four reflection points [m]; only the newest point enters the GP.
import { minimumAssignment } from './range-assignment.mjs';
function association(old,now){
  const result=new Int32Array(now.length).fill(-1),n=Math.max(old.length,now.length);
  if(old.length && now.length)for(const [i,j] of minimumAssignment(n,n,(i,j)=>i<now.length&&j<old.length?Math.abs(now[i]-old[j]):2))
    if(i<now.length&&j<old.length&&Math.abs(now[i]-old[j])<=2)result[i]=j;
  return result;
}

function predict(graphs,rt,neighbors){
  const {weights:w,call}=rt, rows=12*graphs.length;
  let input=new Float32Array(rows*2),at=0;
  for(const graph of graphs)for(const step of graph){input.set(step,at);at+=step.length;}
  const linear=(a,weight,n)=>call('multiply',[a,weight.values],n*weight.shape[1],[n,...weight.shape]);
  const leaky=x=>x<0?.01*x:x;
  for(let layer=0;layer<4;layer++){
    const prefix='gat.'+layer+'.',src=w[prefix+'o_src'],dst=w[prefix+'o_dst'],[heads,d]=src.shape,stride=heads*d;
    const h=linear(input,w[prefix+'W'],rows),a=new Float32Array(rows*heads),b=new Float32Array(a.length);
    for(let i=0;i<rows;i++)for(let k=0;k<heads;k++){
      const offset=i*stride+k*d;let p=0,q=0;
      for(let f=0;f<d;f++){const x=h[offset+f];p+=x*src.values[k*d+f];q+=x*dst.values[k*d+f];}
      a[i*heads+k]=p;b[i*heads+k]=q;
    }
    input=new Float32Array(h.length);
    const scores=new Float64Array(12);
    for(let i=0;i<rows;i++)for(let k=0;k<heads;k++){
      const start=i-i%12,adj=neighbors[i%12];let peak=-Infinity,sum=0;
      for(let j=0;j<adj.length;j++){
        const z=a[i*heads+k]+b[(start+adj[j])*heads+k];
        scores[j]=z<0?.2*z:z;peak=Math.max(peak,scores[j]);
      }
      for(let j=0;j<adj.length;j++)sum+=(scores[j]=Math.exp(scores[j]-peak));
      for(let j=0;j<adj.length;j++)scores[j]/=sum;
      for(let f=0;f<d;f++){
        let agg=0;for(let j=0;j<adj.length;j++)agg+=scores[j]*h[(start+adj[j])*stride+k*d+f];
        input[i*stride+k*d+f]=leaky(agg);
      }
    }
  }
  for(const idx of [0,2,4]){
    const key='mlp.'+idx,inputBias=w[key+'.bias'].values;
    input=linear(input,w[key+'.weight'],graphs.length);
    for(let i=0;i<input.length;i++){const z=input[i]+inputBias[i%inputBias.length];input[i]=idx===4?z:leaky(z);}
  }
  return input;
}

// NumPy PCG64(911) and choice(replace=False) used by the 10-vehicle experiment.
export function gpSubset(n){
  const size=1500,mask=(1n<<64n)-1n;
  let state=113219229968428971613983651843996252106n,buffer;
  function uint32(){
    if(buffer!==undefined){const value=buffer;buffer=undefined;return value;}
    state=BigInt.asUintN(128,state*47026247687942121848144207491837523525n+27494222438246939243530610901005887455n);
    const x=((state>>64n)^state)&mask,rot=state>>122n,raw=((x>>rot)|(x<<((-rot)&63n)))&mask;
    buffer=Number(raw>>32n);return Number(raw&0xffffffffn);
  }
  function bounded(max){
    if(!max)return 0;
    const range=BigInt(max+1),threshold=(1n<<32n)%range;
    for(;;){const product=BigInt(uint32())*range;if((product&0xffffffffn)>=threshold)return Number(product>>32n);}
  }
  const tail=n>10000&&size>Math.floor(n/50),idx=tail?Array.from({length:n},(_,i)=>i):[];
  if(!tail){
    const used=new Set();
    for(let j=n-size;j<n;j++){const v=bounded(j),pick=used.has(v)?j:v;used.add(pick);idx.push(pick);}
  }
  for(let i=idx.length-1;i>=(tail?n-size:1);i--){const j=bounded(i);[idx[i],idx[j]]=[idx[j],idx[i]];}
  return tail?idx.slice(-size):idx;
}

function inliers(points){
  const bins=new Map(),key=(x,y)=>x+','+y;
  for(let i=0;i<points.length;i++){
    const [x,y]=points[i],k=key(Math.floor(x/.9),Math.floor(y/.9));
    if(!bins.has(k))bins.set(k,[]);bins.get(k).push(i);
  }
  function enough(p,min,core){
    const [x,y]=p,bx=Math.floor(x/.9),by=Math.floor(y/.9);let count=0;
    for(let j=by-1;j<=by+1;j++)for(let i=bx-1;i<=bx+1;i++)for(const id of bins.get(key(i,j))??[]){
      const q=points[id];if((!core||core[id])&&(q[0]-x)**2+(q[1]-y)**2<=.81&&++count>=min)return true;
    }return false;
  }
  const core=points.map(p=>enough(p,4));
  return points.filter((p,i)=>core[i]||enough(p,1,core));
}
export class GatGpr{
  constructor(rt,vehicles){
    this.rt=rt;this.vehicles=vehicles;this.pairs=new Map();
    const nodes=Array.from({length:12},(_,i)=>i);
    this.neighbors=nodes.map(i=>nodes.filter(j=>rt.weights.mask.values[12*i+j]));
  }
  step(wire){
    const graphs=[],owners=[],{mu,sd}=this.rt.data;
    for(const c of wire.configs){
      const key=c.i+','+c.j;
      if(!this.pairs.has(key))this.pairs.set(key,{ranges:[],tracks:[],points:[]});
      const pair=this.pairs.get(key),ranges=c.paths.map(p=>p.dHat),assoc=association(pair.ranges,ranges);
      const poses=[...c.pHat_i,...c.pHat_j].map((v,k)=>(v-mu[k%2])/sd[k%2]);
      const tracks=ranges.map((r,i)=>{
        const sample=[...poses,(r-mu[2])/sd[2],0],track=[sample,...(pair.tracks[assoc[i]]??[]).slice(0,3)];
        if(track.length===4){graphs.push(track);owners.push(pair);}
        return track;
      });
      pair.ranges=ranges;pair.tracks=tracks;
    }
    if(graphs.length){
      const pr=predict(graphs,this.rt,this.neighbors);
      owners.forEach((o,i)=>{
        const k=i*8;for(let j=2;j<8;j+=2)if(Math.hypot(pr[k+j]-pr[k+j-2],pr[k+j+1]-pr[k+j-1])>2)return;
        o.points.push([pr[k],pr[k+1]]);
      });
    }
    let points=inliers([...this.pairs.values()].flatMap(p=>p.points));
    if(points.length<4)return {curves:[],candidates:[]};
    let lo=Infinity,hi=-Infinity;for(const [x] of points){lo=Math.min(lo,x);hi=Math.max(hi,x);}
    lo=Math.max(0,lo);hi=Math.min(100,hi);if(hi<=lo)return {curves:[],candidates:[]};
    if(this.vehicles>=10&&points.length>1500)points=gpSubset(points.length).map(i=>points[i]);
    const q=Float64Array.from({length:1200},(_,i)=>lo+(hi-lo)*i/1199);
    const y=this.rt.call('gaussianProcess',[points.map(p=>p[0]),points.map(p=>p[1]),q],q.length,[points.length],Float64Array);
    return {curves:[Array.from(q,(x,i)=>[x,y[i]])],candidates:[]};
  }
}
