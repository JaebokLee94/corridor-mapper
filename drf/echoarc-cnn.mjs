// Input is the current measured Tx/Rx packet. Accumulate 64 upper-arc normal directions
// per ellipse on the training grid (0.5 m). Output curves use the checkpoint's fixed cutoff.
const NX=201, NY=144, STEP=.5, Y0=-20;
const normals=Array.from({length:64},(_,i)=>{
  const a=-63+2*i,r=a*Math.PI/180;
  return [-Math.sin(r),Math.cos(r),Math.floor((a+90)/20)];
});
function normalizeSiLU(data,scale,bias,channels){
  const group=channels/4,count=data.length/4;
  for(let g=0;g<4;g++){
    const first=g*group;let sum=0,square=0;
    for(let i=first;i<data.length;i+=channels)for(let k=0;k<group;k++){
      const v=data[i+k];sum+=v;square+=v*v;
    }
    const mean=sum/count,inv=1/Math.sqrt(Math.max(0,square/count-mean**2)+1e-5);
    for(let i=first;i<data.length;i+=channels)for(let k=0;k<group;k++){
      const c=first+k,v=(data[i+k]-mean)*inv*scale[c]+bias[c];
      data[i+k]=v/(1+Math.exp(-v));
    }
  }
}
function pool({data,h,w,c}){
  const H=h>>1,W=w>>1,a=new Float32Array(H*W*c);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++)for(let k=0;k<c;k++){
    const i=(2*y*w+2*x)*c+k;a[(y*W+x)*c+k]=(data[i]+data[i+c]+data[i+w*c]+data[i+(w+1)*c])*.25;
  }
  return {data:a,h:H,w:W,c};
}
function concatenate(a,b){
  const c=a.c+b.c,data=new Float32Array(a.h*a.w*c);
  for(let y=0;y<a.h;y++)for(let x=0;x<a.w;x++){
    const i=y*a.w+x,j=Math.floor(y*b.h/a.h)*b.w+Math.floor(x*b.w/a.w);
    const out=i*c,ia=i*a.c,ib=j*b.c;
    for(let k=0;k<a.c;k++)data[out+k]=a.data[ia+k];
    for(let k=0;k<b.c;k++)data[out+a.c+k]=b.data[ib+k];
  }
  return {data,h:a.h,w:a.w,c};
}
export function decodeArc(logits,cut){
  let active=[];const done=[],limit=Math.log(cut/(1-cut));
  for(let x=0;x<NX;x++){
    const ys=[];
    for(let y=1;y<NY-1;y++){
      const i=y*NX+x,z=logits[i],lo=logits[i-NX],hi=logits[i+NX];
      if(z<limit||z<lo||z<hi||y>=2&&z<logits[i-2*NX]||y+2<NY&&z<logits[i+2*NX])continue;
      const d=Math.min(.5,Math.max(-.5,.5*(lo-hi)/Math.min(-1e-7,lo-2*z+hi)));
      ys.push(Y0+STEP*(y+d));
    }
    const pairs=[];
    active.forEach((line,i)=>ys.forEach((v,j)=>{const d=Math.abs(line.at(-1)[1]-v);if(d<=1.25)pairs.push([d,i,j]);}));
    pairs.sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);
    const links=new Map(),used=new Set(),next=[];
    for(const [,i,j] of pairs)if(!links.has(i)&&!used.has(j)){links.set(i,j);used.add(j);}
    active.forEach((line,i)=>{if(links.has(i)){line.push([x*STEP,ys[links.get(i)]]);next.push(line);}else if(line.length>=3)done.push(line);});
    ys.forEach((v,j)=>{if(!used.has(j))next.push([[x*STEP,v]]);});active=next;
  }
  return done.concat(active.filter(line=>line.length>=3));
}
// Round normalized channels as in the float16 training cache.
const half=Math.f16round??(v=>{
  if(!v)return 0;
  const unit=2**Math.max(-24,Math.floor(Math.log2(v))-10),q=v/unit,n=Math.floor(q);
  return unit*(q-n===.5?n+n%2:Math.round(q));
});
export class EchoArcCNN{
  constructor(runtime){
    this.rt=runtime;this.votes=new Float32Array(9*NX*NY);this.input=new Float32Array(this.votes.length);
    this.changed=new Uint8Array(NX*NY);this.changedCells=[];this.pairs=0;this.scalePairs=0;
  }
  observe(wire){
    this.pairs=wire.configs.length;
    for(const {pHat_i:a,pHat_j:b,paths} of wire.configs){
      const dx=(a[0]-b[0])/2,dy=(a[1]-b[1])/2,mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2;
      for(const {dHat:r} of paths){
        const b2=(r/2)**2-dx*dx-dy*dy;if(r<=0||b2<=0)continue;
        for(const [nx,ny,c] of normals){
          const dot=nx*dx+ny*dy,den=Math.sqrt(b2+dot*dot);
          const x=(mx+(b2*nx+dx*dot)/den)/STEP,y=(my+(b2*ny+dy*dot)/den-Y0)/STEP,ix=Math.floor(x),iy=Math.floor(y);
          for(let j=iy;j<=iy+1;j++)for(let i=ix;i<=ix+1;i++)if(i>=0&&i<NX&&j>=0&&j<NY){
            const cell=j*NX+i;
            this.votes[cell*9+c]+=(1-Math.abs(x-i))*(1-Math.abs(y-j))/64;
            if(!this.changed[cell]){this.changed[cell]=1;this.changedCells.push(cell);}
          }
        }
      }
    }
  }
  estimate(){
    const input=this.input,scaleChanged=this.pairs!==this.scalePairs;
    const n=scaleChanged?NX*NY:this.changedCells.length;
    let dirty=!this.curves;
    for(let j=0;j<n;j++){
      const cell=scaleChanged?j:this.changedCells[j],i=cell*9;
      this.changed[cell]=0;
      let mass=0;for(let k=0;k<9;k++)mass+=this.votes[i+k];
      if(!mass)continue;
      const gain=Math.log1p(mass*27/this.pairs)/mass;let total=0;
      for(let k=0;k<9;k++)total+=half(this.votes[i+k]*gain);
      const value=this.pairs?Math.fround(total/9):NaN;
      if(!Object.is(value,input[i])){input.fill(value,i,i+9);dirty=true;}
    }
    this.scalePairs=this.pairs;this.changedCells.length=0;
    if(dirty){
      this.curves=undefined;
      this.curves=this.network(input);
    }
    return {curves:this.curves.map(line=>line.map(p=>[...p])),candidates:[]};
  }
  step(wire){
    this.observe(wire);return this.estimate();
  }
  network(input){
    const {weights,call}=this.rt;
    const conv=(v,name,dilation=1)=>{
      const {shape,values}=weights[name+'.weight'],[kernel,,inc,c]=shape;
      const data=call('convolution',[v.data,values,weights[name+'.bias'].values],v.h*v.w*c,[v.h,v.w,inc,c,kernel,dilation]);
      return {...v,data,c};
    };
    const block=(v,name,d=1)=>{
      for(const i of [0,3]){v=conv(v,name+'.'+i,i===0?d:1);normalizeSiLU(v.data,weights[name+'.'+(i+1)+'.weight'].values,weights[name+'.'+(i+1)+'.bias'].values,v.c);}
      return v;
    };
    const a=block({data:input,h:NY,w:NX,c:9},'e0'),b=block(pool(a),'e1'),c=block(pool(b),'b',2);
    const d=block(concatenate(b,c),'d1'),e=block(concatenate(a,d),'d0');
    return decodeArc(conv(e,'out').data,this.rt.data.threshold);
  }
}
