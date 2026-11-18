// Four consecutive measured echoes per Tx/Rx link form a 12-node graph. The trained
// network predicts four reflection points [m]; only the newest point enters the GP.
import { minimumAssignment } from './range-assignment.mjs';
import { createGatGpu } from './gat-gpu.mjs?v=20261118-device-selection';
function association(old,now){
  const result=new Int32Array(now.length).fill(-1),n=Math.max(old.length,now.length);
  if(old.length && now.length)for(const [i,j] of minimumAssignment(n,n,(i,j)=>i<now.length&&j<old.length?Math.abs(now[i]-old[j]):2))
    if(i<now.length&&j<old.length&&Math.abs(now[i]-old[j])<=2)result[i]=j;
  return result;
}

function* predictionLayers(graphs,rt,neighbors){
  const {weights:w}=rt, rows=12*graphs.length;
  let input=new Float32Array(rows*2),at=0;
  for(const graph of graphs)for(const step of graph){input.set(step,at);at+=step.length;}
  const leaky=x=>x<0?.01*x:x;
  for(let layer=0;layer<4;layer++){
    const prefix='gat.'+layer+'.',src=w[prefix+'o_src'],dst=w[prefix+'o_dst'],[heads,d]=src.shape,stride=heads*d;
    const h=yield [input,prefix+'W',rows],a=new Float32Array(rows*heads),b=new Float32Array(a.length);
    for(let i=0;i<rows;i++)for(let k=0;k<heads;k++){
      const offset=i*stride+k*d;let p=0,q=0;
      for(let f=0;f<d;f++){const x=h[offset+f];p+=x*src.values[k*d+f];q+=x*dst.values[k*d+f];}
      a[i*heads+k]=p;b[i*heads+k]=q;
    }
    input=new Float32Array(h.length);
    const scores=new Float64Array(12),aggregate=new Float64Array(d);
    for(let i=0;i<rows;i++)for(let k=0;k<heads;k++){
      const start=i-i%12,adj=neighbors[i%12];let peak=-Infinity,sum=0;
      for(let j=0;j<adj.length;j++){
        const z=a[i*heads+k]+b[(start+adj[j])*heads+k];
        scores[j]=z<0?.2*z:z;peak=Math.max(peak,scores[j]);
      }
      for(let j=0;j<adj.length;j++)sum+=(scores[j]=Math.exp(scores[j]-peak));
      aggregate.fill(0);
      for(let j=0;j<adj.length;j++){
        const weight=scores[j]/sum,offset=(start+adj[j])*stride+k*d;
        for(let f=0;f<d;f++)aggregate[f]+=weight*h[offset+f];
      }
      const offset=i*stride+k*d;
      for(let f=0;f<d;f++)input[offset+f]=leaky(aggregate[f]);
    }
  }
  for(const idx of [0,2,4]){
    const key='mlp.'+idx,inputBias=w[key+'.bias'].values;
    input=yield [input,key+'.weight',graphs.length];
    for(let i=0;i<input.length;i++){const z=input[i]+inputBias[i%inputBias.length];input[i]=idx===4?z:leaky(z);}
  }
  return input;
}

function predict(graphs,rt,neighbors){
  const layers=predictionLayers(graphs,rt,neighbors);let layer=layers.next();
  while(!layer.done){
    const [input,name,rows]=layer.value,weight=rt.weights[name];
    layer=layers.next(rt.call('multiply',[input,weight.values],rows*weight.shape[1],[rows,...weight.shape]));
  }
  return layer.value;
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

// Historical reflection points never move. DBSCAN core/border membership can only grow.
function nearby(point,bins,minimum,core){
  const [x,y]=point,bx=Math.floor(x/.9),by=Math.floor(y/.9);let count=0;
  for(let j=by-1;j<=by+1;j++)for(let i=bx-1;i<=bx+1;i++){
    const bin=bins.get(i+','+j);
    if(bin)for(const q of bin)if((!core||core.has(q))&&(q[0]-x)**2+(q[1]-y)**2<=.81&&++count>=minimum)return true;
  }
  return false;
}
export class GatGpr{
  constructor(rt,vehicles){
    this.rt=rt;this.vehicles=vehicles;this.pairs=new Map();
    this.gatMs=0;this.gprMs=0;this.maxGraphRows=0;
    this.bins=new Map();this.core=new Set();this.inliers=new Set();this.changed=false;
    this.previousPoints=[];this.curve=[];
    const nodes=Array.from({length:12},(_,i)=>i);
    this.neighbors=nodes.map(i=>nodes.filter(j=>rt.weights.mask.values[12*i+j]));
  }
  graphsFor(wire){
    const graphs=[],owners=[],{mu,sd}=this.rt.data;
    for(const c of wire.configs){
      const key=c.i+','+c.j;
      if(!this.pairs.has(key))this.pairs.set(key,{ranges:[],tracks:[],points:[]});
      const pair=this.pairs.get(key);
      if(!c.paths.length){pair.ranges=[];pair.tracks=[];continue;}
      const ranges=c.paths.map(p=>p.dHat),assoc=association(pair.ranges,ranges);
      const poses=[...c.pHat_i,...c.pHat_j].map((v,k)=>(v-mu[k%2])/sd[k%2]);
      const tracks=ranges.map((r,i)=>{
        const sample=[...poses,(r-mu[2])/sd[2],0],track=[sample,...(pair.tracks[assoc[i]]??[]).slice(0,3)];
        if(track.length===4){graphs.push(track);owners.push(pair);}
        return track;
      });
      pair.ranges=ranges;pair.tracks=tracks;
    }
    this.maxGraphRows=Math.max(this.maxGraphRows,12*graphs.length);
    return {graphs,owners};
  }
  acceptPrediction(pr,owners){
    owners.forEach((o,i)=>{
        const k=i*8;for(let j=2;j<8;j+=2)if(Math.hypot(pr[k+j]-pr[k+j-2],pr[k+j+1]-pr[k+j-1])>2)return;
        const point=[pr[k],pr[k+1]],key=Math.floor(point[0]/.9)+','+Math.floor(point[1]/.9);
        if(!this.bins.has(key))this.bins.set(key,[]);
        this.bins.get(key).push(point);o.points.push(point);this.changed=true;
    });
  }
  observe(wire){
    const {graphs,owners}=this.graphsFor(wire);
    if(!graphs.length)return;
    const start=performance.now(),pr=predict(graphs,this.rt,this.neighbors);
    this.gatMs+=performance.now()-start;this.acceptPrediction(pr,owners);
  }
  async useGpu(){
    if(this.closed)return false;
    if(this.gpu)return true;
    const gpu=createGatGpu(this.rt);
    if(!gpu){this.gpuFallbackReason='WebGPU unavailable';return false;}
    try{
      await gpu.ready;
      if(this.closed){gpu.close();return false;}
      this.gpu=gpu;this.gpuFallbackReason='';return true;
    }catch(error){gpu.close();this.gpuFallbackReason=String(error.message??error);return false;}
  }
  close(){this.closed=true;this.gpu?.close();}
  async observeAsync(wire){
    if(!this.gpu)return this.observe(wire);
    const {graphs,owners}=this.graphsFor(wire);
    if(!graphs.length)return;
    const start=performance.now(),gpu=this.gpu;let pr;
    try{
      const layers=predictionLayers(graphs,this.rt,this.neighbors);let layer=layers.next();
      while(!layer.done)layer=layers.next(await gpu.multiply(...layer.value));
      if(this.closed)throw new Error('GAT estimator is closed');
      pr=layer.value;
    }catch(error){
      if(this.closed)throw error;
      this.gpuCallsBeforeLoss=gpu.completedCalls;this.gpuFallbackReason=String(error.message??error);
      gpu.close();this.gpu=null;
      // The tracks are already recorded; recompute these graphs without recording the wire twice.
      pr=predict(graphs,this.rt,this.neighbors);
    }
    this.gatMs+=performance.now()-start;this.acceptPrediction(pr,owners);
  }
  async stepAsync(wire){
    await this.observeAsync(wire);return this.estimate();
  }
  fit(){
    // Preserve link order for NumPy subset selection and the GP factorization.
    const all=[...this.pairs.values()].flatMap(pair=>pair.points);
    for(const p of all)if(!this.core.has(p)&&nearby(p,this.bins,4))this.core.add(p);
    let points=all.filter(p=>{
      if(this.inliers.has(p))return true;
      if(!this.core.has(p)&&!nearby(p,this.bins,1,this.core))return false;
      this.inliers.add(p);return true;
    });
    if(points.length<4)return;
    let lo=Infinity,hi=-Infinity;for(const [x] of points){lo=Math.min(lo,x);hi=Math.max(hi,x);}
    lo=Math.max(0,lo);hi=Math.min(100,hi);if(hi<=lo)return;
    if(this.vehicles>=10&&points.length>1500)points=gpSubset(points.length).map(i=>points[i]);
    if(lo===this.lo&&hi===this.hi&&points.length===this.previousPoints.length&&points.every((p,i)=>p===this.previousPoints[i]))return;
    const q=Float64Array.from({length:1200},(_,i)=>lo+(hi-lo)*i/1199);
    const start=performance.now();
    const y=this.rt.call('gaussianProcess',[points.map(p=>p[0]),points.map(p=>p[1]),q],q.length,[points.length],Float64Array);
    this.gprMs+=performance.now()-start;
    this.curve=Array.from(q,(x,i)=>[x,y[i]]);
    this.previousPoints=points;this.lo=lo;this.hi=hi;
  }
  estimate(){
    if(this.changed){this.fit();this.changed=false;}
    return {curves:this.curve.length?[this.curve.map(p=>[...p])]:[],candidates:[]};
  }
  step(wire){
    this.observe(wire);return this.estimate();
  }
}
