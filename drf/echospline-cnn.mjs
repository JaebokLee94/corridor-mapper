// Frozen EchoSpline-CNN. The measured-prefix fit supplies x [N, m], inverse
// points [P, (x,y,dy/dx)] and the fixed 2 m spline. The GBDT supplies its anchor.
// Output logits [81,N] span ±16 m around each anchor at 0.4 m resolution.
// Fixed network width: O(31P + 81N) work and O(81N) temporary memory.
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
function voteImage(x,coarse,anchor,points) {
  const n=x.length, cells=H*n, channels=11;
  const input=new Float32Array(cells*channels);
  const masked=Float64Array.from(anchor,v=>Number.isFinite(v)?v:0);
  const xx=Float32Array.from(x), initial=Float32Array.from(masked);
  for(const point of points) {
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
          const k=(lo*n+j)*channels+2*r, hit=weight*(1-frac);
          input[k]+=hit;input[k+1]+=hit*slope;
        }
        if(lo+1<H){
          const k=((lo+1)*n+j)*channels+2*r, hit=weight*frac;
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
      for(let r=0;r<6;r+=2){
        const mass=input[k+r];
        input[k+r+1]=half(input[k+r+1]/(1+mass)); input[k+r]=half(Math.log1p(mass));
      }
      input[k+6]=offset;input[k+7]=gaussian;
      for(let a=0;a<3;a++)input[k+8+a]=axes[a][j];
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
  const dilations=[[1,2],[1,4],[2,8],[3,12]];
  for(let layer=0;layer<dilations.length;layer++){
    const [dz,dx]=dilations[layer], next=convolution(rt,y,'blocks.'+layer,n,dz,dx);
    for(let i=0;i<y.length;i++)y[i]+=Math.max(0,next[i]);
  }
  const logits=convolution(rt,y,'end',n,1,1);
  for(let i=0;i<logits.length;i++)logits[i]-=Math.abs(input[i*11+6]);
  return logits;
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

export function splineCnnProposal(rt,fit,gbdtCurves) {
  const {x,heights,points}=fit,n=x.length;
  const anchor=new Float64Array(n).fill(NaN), coarse=new Float64Array(n).fill(NaN);
  for(const line of gbdtCurves)for(const [q,height] of line){
    const i=Math.round((q-x[0])/DX);
    if(i<0||i>=n||Math.abs(q-x[i])>1e-5||!Number.isFinite(height)||!Number.isFinite(heights[i]))continue;
    anchor[i]=height;coarse[i]=heights[i];
  }
  const input=voteImage(x,coarse,anchor,points);
  const logits=logitsFromVotes(rt,input,n);
  return {base:decodeSplineCnn(logits,anchor,rt.data.penalty),anchor,logits};
}
