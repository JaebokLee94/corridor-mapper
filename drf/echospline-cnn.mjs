import {splineRangeImage} from './spline-cnn-range.mjs?v=20261118-device-selection-final';

// Measured-prefix fit: x [N,m], multiscale inverse points [P,(x,y,dy/dx)],
// configurations and a GBDT anchor. Scores [81,N] span ±16 m at 0.4 m spacing.
// Cost: O(31P + 81N(C(log D + K) + Lw²)); temporary memory O(81Nw).
// C configs, D paths/config, K nearby paths, L layers, w channels; weights O(Lw²).
const H = 81, MID = 40, DZ = .4, DX = .2;
const f32 = Math.fround;
function roundEven(x) {
  const lo = Math.floor(x);
  return x-lo===.5 ? lo+(lo&1) : Math.round(x);
}
// Match the FP16 feature storage used by the original PyTorch model.
const half = Math.f16round ?? (v => {
  if(!v) return v;
  const step = 2**(Math.max(-14,Math.floor(Math.log2(Math.abs(v))))-10);
  return roundEven(v/step)*step;
});
const clipUnit = v => Math.min(4,Math.max(-4,v)) / 4;
const radii = [.45,1.2,2.4];
function gradient(a) {
  const n=a.length, g=new Float64Array(n);
  for(let i=0;i<n;i++){
    const lo=Math.max(0,i-1),hi=Math.min(n-1,i+1);
    g[i]=(a[hi]-a[lo])/((hi-lo)*DX);
  }
  return g;
}
function voteImage(x,coarse,anchor,pointSets,range) {
  const n=x.length, cells=H*n, histogramChannels=pointSets.length*6;
  const channels=histogramChannels+(range?3:0)+5,prior=channels-5;
  const input=new Float32Array(cells*channels);
  const masked=Float64Array.from(anchor,v=>Number.isFinite(v)?v:0);
  const xx=Float32Array.from(x), initial=Float32Array.from(masked);
  for(let source=0;source<pointSets.length;source++)for(const point of pointSets[source]) {
    const px=f32(point[0]), py=f32(point[1]), slope=f32(point[2]);
    const center=roundEven(f32(f32(px-f32(x[0]))/f32(DX)));
    for(let j=Math.max(0,center-15);j<=Math.min(n-1,center+15);j++){
      const delta=f32(xx[j]-px);
      const height=f32(f32(py+f32(slope*delta))-initial[j]);
      const bin=f32(f32(height/f32(DZ))+MID);
      const lo=Math.floor(bin), frac=bin-lo;
      if(lo < -1 || lo>=H) continue;
      for(let r=0;r<radii.length;r++){
        const weight=Math.exp(-.5*(delta/radii[r])**2);
        if(lo>=0){
          const k=(lo*n+j)*channels+6*source+2*r, hit=weight*(1-frac);
          input[k]+=hit;input[k+1]+=hit*slope;
        }
        if(lo+1<H){
          const k=((lo+1)*n+j)*channels+6*source+2*r, hit=weight*frac;
          input[k]+=hit;input[k+1]+=hit*slope;
        }
      }
    }
  }
  const grad=gradient(masked), second=gradient(grad);
  const axes=[Float32Array.from(coarse,(v,i)=>half(Number.isFinite(v)?clipUnit(v-masked[i]):0)),
    Float32Array.from(grad,v=>half(clipUnit(v))),Float32Array.from(second,v=>half(clipUnit(v)))];
  for(let z=0;z<H;z++){
    const m=(z-MID)*DZ, offset=half(m/16), gaussian=half(Math.exp(-.5*(m/.5)**2));
    for(let j=0;j<n;j++){
      const k=(z*n+j)*channels;
      for(let r=0;r<histogramChannels;r+=2){
        const mass=input[k+r];
        input[k+r+1]=half(input[k+r+1]/(1+mass)); input[k+r]=half(Math.log1p(mass));
      }
      if(range)for(let r=0;r<3;r++)input[k+histogramChannels+r]=half(range[(z*n+j)*3+r]);
      input[k+prior]=offset;input[k+prior+1]=gaussian;
      for(let a=0;a<3;a++)input[k+prior+2+a]=axes[a][j];
    }
  }
  return input;
}

function convolution(rt,input,name,n,dz,dx) {
  const {values,shape}=rt.weights[name+'.weight'],[kernel,,inc,out]=shape;
  const bias=rt.weights[name+'.bias'].values;
  return rt.call('convolutionXY',[input,values,bias],H*n*out,[H,n,inc,out,kernel,dz,dx]);
}
function logitsFromVotes(rt,input,n) {
  let y=convolution(rt,input,'start',n,1,1);
  for(let i=0;i<y.length;i++)y[i]=Math.max(0,y[i]);
  const dilations=rt.data.dilations??[[1,2],[1,4],[2,8],[3,12]];
  for(let layer=0;layer<dilations.length;layer++){
    const [dz,dx]=dilations[layer], next=convolution(rt,y,'blocks.'+layer,n,dz,dx);
    for(let i=0;i<y.length;i++)y[i]+=Math.max(0,next[i]);
  }
  return convolution(rt,y,'end',n,1,1);
}
export function decodeSplineCnn(logits,anchor,penalty=.5){
  const n=anchor.length, base=new Float64Array(n).fill(NaN);
  const back=new Uint8Array(H*n);
  let previous=new Float64Array(H), next=new Float64Array(H);
  for(let start=0;start<n;){
    if(!Number.isFinite(anchor[start])){start++;continue;}
    let end=start;
    for(let z=0;z<H;z++)previous[z]=logits[z*n+start];
    while(end+1<n && Number.isFinite(anchor[end+1])){
      end++;
      for(let z=0;z<H;z++){
        let best=-Infinity,id=0;
        for(let k=Math.max(0,z-4);k<=Math.min(H-1,z+4);k++){
          const candidate=previous[k]-penalty*Math.abs(k-z);
          if(candidate>best){best=candidate;id=k;}
        }
        next[z]=best+logits[z*n+end];back[end*H+z]=id;
      }
      [previous,next]=[next,previous];
    }
    let z=0;
    for(let k=1;k<H;k++)if(previous[k]>previous[z])z=k;
    for(let j=end;j>=start;j--){
      const lo=Math.max(0,z-1),hi=Math.min(H-1,z+1);
      let max=-Infinity, sum=0,moment=0;
      for(let k=lo;k<=hi;k++)max=Math.max(max,logits[k*n+j]);
      for(let k=lo;k<=hi;k++){
        const w=Math.exp(logits[k*n+j]-max);sum+=w;moment+=k*w;
      }
      base[j]=anchor[j]+DZ*(moment/sum-MID);z=back[j*H+z];
    }
    start=end+1;
  }
  return base;
}

export function splineCnnProposal(rt,fit,gbdtCurves,evidence) {
  const {x,heights,points}=fit,n=x.length;
  const anchor=new Float64Array(n).fill(NaN), coarse=new Float64Array(n).fill(NaN);
  for(const line of gbdtCurves)for(const [q,height] of line){
    const i=Math.round((q-x[0])/DX);
    if(i<0||i>=n||Math.abs(q-x[i])>1e-5||!Number.isFinite(height)||!Number.isFinite(heights[i]))continue;
    anchor[i]=height;coarse[i]=heights[i];
  }
  const channels=rt.weights['start.weight'].shape[2];
  if(channels>11&&evidence?.points?.length!==2)throw new Error('EchoSpline-CNN requires its measured multiscale candidates');
  const pointSets=channels>11?[points,...evidence.points]:[points];
  const infer=range=>{
    const input=voteImage(x,coarse,anchor,pointSets,range);
    const finish=logits=>{
      for(let i=0;i<logits.length;i++)logits[i]-=Math.abs(input[i*channels+channels-5]);
      return {base:decodeSplineCnn(logits,anchor,rt.data.penalty),anchor,logits};
    };
    return rt.gpu?rt.gpu.estimate(input,n).then(finish):finish(logitsFromVotes(rt,input,n));
  };
  const range=channels===26?splineRangeImage(rt,x,anchor,evidence.configs,evidence.links,evidence.sign):null;
  if(rt.gpu)return Promise.resolve(range).then(infer).catch(error=>{
    if(rt.closed)throw error;
    rt.gpuCallsBeforeLoss=rt.gpu?.completedCalls??0;rt.gpu?.close();rt.gpu=null;
    return splineCnnProposal(rt,fit,gbdtCurves,evidence);
  });
  return infer(range);
}
