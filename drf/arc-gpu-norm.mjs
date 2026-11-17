import {exactArcMath} from './arc-gpu-math.mjs?v=20261117-arc-resident';

// In-place GroupNorm(4) and SiLU for a contiguous [H,W,C] binary32 tensor.
// Fixed-exponent runs reproduce the reference's sequential binary64 additions
// in parallel. Boundary runs replay the original order on the GPU. Scratch and
// arithmetic scale linearly with H*W*C. No activations cross the device boundary.
const wgsl = `
struct Config { channels:u32, count:u32, blocks:u32, mask:u32 }
@group(0) @binding(0) var<storage,read_write> z:array<f32>;
@group(0) @binding(1) var<storage,read_write> moments:array<vec4u>;
@group(0) @binding(2) var<storage,read> affine:array<f32>;
@group(0) @binding(3) var<storage,read> exps:array<vec2f>;
@group(0) @binding(4) var<uniform> p:Config;
// Keep the leading rounded value observable on drivers that contract expressions.
fn r(x:f32)->f32 {return bitcast<f32>(bitcast<u32>(x)&p.mask);}
fn pair(x:f32)->vec2f {return vec2f(x,0);}
fn renorm(x:f32,y:f32)->vec2f {
  let h=r(x+y);return vec2f(h,r(y-r(h-x)));
}
fn add(x:vec2f,y:vec2f)->vec2f {
  let s=r(x.x+y.x);let v=r(s-x.x);
  let e=r(r(x.x-r(s-v))+r(y.x-v));return renorm(s,r(e+r(x.y+y.y)));
}
fn product(a:f32,b:f32)->vec2f {
  let v=r(a*b);return vec2f(v,fma(a,b,-v));
}
fn mul(a:vec2f,b:vec2f)->vec2f {
  let v=product(a.x,b.x);
  return renorm(v.x,r(v.y+r(r(a.x*b.y)+r(a.y*b.x))));
}
fn div2(a:vec2f,b:vec2f)->vec2f {
  let q=r(a.x/b.x);
  let rem=add(a,-mul(pair(q),b));
  return renorm(q,r(rem.x/b.x));
}
fn expNeg(x:vec2f)->vec2f {
  let n=i32(round(x.x*369.3299304675746));
  let red=add(x,-mul(pair(f32(n)),vec2f(0.0027076061815023422,-7.440055949797797e-12)));
  let t=red.x;
  let j=n & 255;
  let sc=bitcast<f32>(u32((n>>8)+127)<<23u);
  let e=exps[u32(j)] * sc;
  // |red| <= ln(2)/512. Terms of order five and above change the result by < 4e-17.
  let rem=mul(mul(red,red),add(pair(.5),mul(red,add(vec2f(.1666666716337204,-4.967053879312289e-9),pair(t*.0416666666666667)))));
  return add(e,mul(e,add(red,rem)));
}
// Finite binary64 values as a 53-bit significand, signed exponent and sign.
// The inputs are binary32 values or their exact squares, so subnormals of binary64 cannot occur.
struct D { m:vec2u, e:i32, neg:bool }
fn shl(a:vec2u,n:u32)->vec2u {
  if(n==0u){return a;}if(n>=32u){return vec2u(0,a.x<<(n-32u));}
  return vec2u(a.x<<n,(a.y<<n)|(a.x>>(32u-n)));
}
fn shr(a:vec2u,n:u32)->vec2u {
  if(n==0u){return a;}if(n>=64u){return vec2u(0);}
  if(n>=32u){return vec2u(a.y>>(n-32u),0);}
  return vec2u((a.x>>n)|(a.y<<(32u-n)),a.y>>n);
}
fn jam(a:vec2u,n:u32)->vec2u{
  if(n==0u){return a;}
  var b=shr(a,n);if(n>=64u){return vec2u(u32(any(a!=vec2u(0))),0);}
  b.x|=u32(any(shl(b,n)!=a));return b;
}
fn plus(a:vec2u,b:vec2u)->vec2u{let l=a.x+b.x;return vec2u(l,a.y+b.y+u32(l<a.x));}
fn minus(a:vec2u,b:vec2u)->vec2u{return vec2u(a.x-b.x,a.y-b.y-u32(a.x<b.x));}
fn dadd(x:D,y:D)->D {
  if(all(x.m==vec2u(0))){return y;}
  if(all(y.m==vec2u(0))){return x;}
  var a=x;var b=y;
  if(a.e<b.e || (a.e==b.e && (a.m.y<b.m.y || (a.m.y==b.m.y && a.m.x<b.m.x)))){
    a=y;b=x;
  }
  let am=shl(a.m,3u);let bm=jam(shl(b.m,3u),u32(a.e-b.e));
  var m=select(minus(am,bm),plus(am,bm),a.neg==b.neg);
  if(all(m==vec2u(0))){return D(m,0,false);}
  var e=a.e;
  if(m.y>=0x1000000u){m=jam(m,1u);e++;}
  else if(m.y<0x800000u){
    let n=select(countLeadingZeros(m.y),32u+countLeadingZeros(m.x),m.y==0u)-8u;
    m=shl(m,n);e-=i32(n);
  }
  let tail=m.x&7u;m=shr(m,3u);
  if(tail>4u || (tail==4u && (m.x&1u)!=0u)){m=plus(m,vec2u(1,0));}
  if(m.y>=0x200000u){m=shr(m,1u);e++;}
  return D(m,e,a.neg);
}
fn term(v:f32,squared:bool)->D {
  let b=bitcast<u32>(v);var m=(b&0x7fffffu)|0x800000u;var e=i32((b>>23u)&255u)-127;
  if(e== -127){
    m=b&0x7fffffu;if(m==0u){return D(vec2u(0),0,false);}
    let n=countLeadingZeros(m)-8u;m<<=n;e= -126-i32(n);
  }
  if(!squared){return D(vec2u(m<<29u,m>>3u),e,b>>31u!=0u);}
  let h=m>>12u;let l=m&4095u;let ll=l*l;let cross=2u*h*l+(ll>>12u);let hh=h*h+(cross>>12u);
  let product=vec2u((ll&4095u)|((cross&4095u)<<12u)|(hh<<24u),hh>>8u);
  let n=select(6u,5u,product.y>=32768u);
  return D(shl(product,n),2*e+select(0,1,n==5u),false);
}
fn tods(a:D)->vec2f{
  if(all(a.m==vec2u(0))){return vec2f(0);}
  let sign=select(1.,-1.,a.neg);
  let hi=ldexp(f32((a.m.y<<3u)|(a.m.x>>29u)),a.e-23);
  let lo=ldexp(f32(a.m.x&0x1fffffffu),a.e-52);
  return sign*renorm(hi,lo);
}

${exactArcMath}
var<workgroup> partials:array<vec4f,64>;
var<workgroup> deltas:array<vec4u,64>;
// [sum, sum of squares, smallest prefix sum, largest prefix sum].
fn join(a:vec4f,b:vec4f)->vec4f {return vec4f(a.xy+b.xy,min(a.z,a.x+b.z),max(a.w,a.x+b.w));}
fn at(g:u32,i:u32)->f32{
  let size=p.channels/4u;return z[(i/size)*p.channels+i%size+g*size];
}
@compute @workgroup_size(16)
fn partial(@builtin(workgroup_id) id:vec3u,@builtin(local_invocation_index) k:u32){
  let i=id.x*16u+k;var a=vec4f(0);
  if(i<p.count){let v=at(id.y,i);a=vec4f(v,v*v,min(v,0.),max(v,0.));}
  partials[k]=a;
  for(var s=1u;s<16u;s<<=1u){workgroupBarrier();if((k&((s<<1u)-1u))==0u){partials[k]=join(partials[k],partials[k+s]);}}
  if(k==0u){moments[id.y*p.blocks+id.x]=bitcast<vec4u>(partials[0]);}
}
// Approximate incoming exponents select candidate integer grids. finish()
// checks each candidate against the actual binary64 accumulator before using it.
@compute @workgroup_size(64)
fn prefix(@builtin(workgroup_id) id:vec3u,@builtin(local_invocation_index) k:u32){
  let width=(p.blocks+63u)/64u;let start=k*width;let end=min(p.blocks,start+width);
  var v=vec4f(0);
  for(var i=start;i<end;i++){v+=bitcast<vec4f>(moments[id.x*p.blocks+i]);}
  partials[k]=v;
  for(var s=1u;s<64u;s<<=1u){
    workgroupBarrier();
    var left=vec4f(0);if(k>=s){left=partials[k-s];}
    workgroupBarrier();partials[k]+=left;
  }
  workgroupBarrier();
  v=vec4f(0);if(k>0u){v=partials[k-1u];}
  for(var i=start;i<end;i++){
    let slot=id.x*p.blocks+i;
    moments[4u*p.blocks+slot]=bitcast<vec4u>(v);
    v+=bitcast<vec4f>(moments[slot]);
  }
}
// Within one binary64 binade every accumulator shares one ulp. Its increment
// depends only on the incoming low bit when a sample lies at half an ulp.
fn increment(v:D,e:i32)->vec4u {
  if(all(v.m==vec2u(0)) || v.e>e){return vec4u(0);}
  let aligned=jam(shl(v.m,3u),u32(e-v.e));let tail=aligned.x&7u;
  let floor=shr(aligned,3u);
  let d0=plus(floor,vec2u(u32(tail>4u || (tail==4u && (floor.x&1u)!=0u)),0));
  let d1=plus(floor,vec2u(u32(tail>4u || (tail==4u && (floor.x&1u)==0u)),0));
  return select(vec4u(d0,d1),vec4u(minus(vec2u(0),d0),minus(vec2u(0),d1)),v.neg);
}
fn compose(first:vec4u,second:vec4u)->vec4u{
  return vec4u(plus(first.xy,select(second.xy,second.zw,(first.x&1u)!=0u)),
               plus(first.zw,select(second.zw,second.xy,(first.z&1u)!=0u)));
}
fn binade(v:f32)->i32{return i32((bitcast<u32>(v)>>23u)&255u)-127;}
@compute @workgroup_size(16)
fn transfers(@builtin(workgroup_id) id:vec3u,@builtin(local_invocation_index) k:u32){
  let slot=id.y*p.blocks+id.x;
  let guess=bitcast<vec4f>(moments[4u*p.blocks+slot]);
  let i=id.x*16u+k;var v=0.;if(i<p.count){v=at(id.y,i);}
  for(var which=0u;which<2u;which++){
    let delta=increment(term(v,which==1u),binade(guess[which]));
    deltas[k]=delta;
    for(var s=1u;s<16u;s<<=1u){
      workgroupBarrier();
      if((k&((s<<1u)-1u))==0u){deltas[k]=compose(deltas[k],deltas[k+s]);}
    }
    if(k==0u){moments[(8u+4u*which)*p.blocks+slot]=deltas[0];}
    workgroupBarrier();
  }
}
// Combine 32 consecutive 16-sample blocks. Flags track disagreement in candidate exponents.
fn regionCount()->u32{return (p.blocks+31u)/32u;}
fn statOffset()->u32{return 16u*p.blocks+16u*regionCount();}
var<workgroup> flags:array<u32,32>;
@compute @workgroup_size(32)
fn regions(@builtin(workgroup_id) id:vec3u,@builtin(local_invocation_index) k:u32){
  let first=id.x*32u+id.y*p.blocks;let tile=id.x*32u+k;let slot=first+k;
  let dest=16u*p.blocks+4u*(id.y*regionCount()+id.x);
  let start=bitcast<vec4f>(moments[4u*p.blocks+first]);var guess=start;
  partials[k]=vec4f(0);if(tile<p.blocks){partials[k]=bitcast<vec4f>(moments[slot]);guess=bitcast<vec4f>(moments[4u*p.blocks+slot]);}
  flags[k]=u32(binade(start.x)!=binade(guess.x)) | (u32(binade(start.y)!=binade(guess.y))<<1u);
  for(var which=0u;which<2u;which++){
    deltas[k]=vec4u(0);if(tile<p.blocks){deltas[k]=moments[(8u+4u*which)*p.blocks+slot];}
    for(var s=1u;s<32u;s<<=1u){workgroupBarrier();if((k&((s<<1u)-1u))==0u){
      deltas[k]=compose(deltas[k],deltas[k+s]);
      if(which==0u){partials[k]=join(partials[k],partials[k+s]);flags[k]|=flags[k+s];}
    }}
    if(k==0u){moments[dest+2u+which]=deltas[0];}workgroupBarrier();
  }
  if(k==0u){moments[dest]=bitcast<vec4u>(partials[0]);moments[dest+1u]=vec4u(bitcast<vec2u>(start.xy),flags[0],0);}
}
fn inBinade(a:D,guess:f32,lo:f32,hi:f32)->bool{
  if(a.e!=binade(guess) || a.m.y==0u){return false;}
  let base=ldexp(1.,a.e);
  let high=abs(tods(a).x);
  // A region contains at most 512 signed terms. Each term is the difference
  // of adjacent prefixes. Cover the nine-level binary32 bounds reduction,
  // the binary32 endpoint conversion and the much smaller binary64 roundoff.
  let margin=(max(abs(lo),abs(hi))+base)*.002;
  let small=select(lo,-hi,a.neg);let big=select(hi,-lo,a.neg);
  return high+small-margin>base && high+big+margin<2.*base;
}
fn applyDelta(a:D,delta:vec4u)->D{
  let d=select(delta.xy,delta.zw,(a.m.x&1u)!=0u);
  return D(select(plus(a.m,d),minus(a.m,d),a.neg),a.e,a.neg);
}
@compute @workgroup_size(1)
fn finish(@builtin(global_invocation_id) id:vec3u){
  var s=D(vec2u(0),0,false);var sq=s;
  for(var region=0u;region<regionCount();region++){
    let off=16u*p.blocks+4u*(id.x*regionCount()+region);
    let regionBounds=bitcast<vec4f>(moments[off]);let info=moments[off+1u];let start=bitcast<vec2f>(info.xy);
    let regionS=(info.z&1u)==0u && inBinade(s,start.x,regionBounds.z,regionBounds.w);
    let regionQ=(info.z&2u)==0u && inBinade(sq,start.y,0.,regionBounds.y);
    if(regionS){s=applyDelta(s,moments[off+2u]);}
    if(regionQ){sq=applyDelta(sq,moments[off+3u]);}
    if(regionS && regionQ){continue;}
    for(var block=region*32u;block<min(p.blocks,(region+1u)*32u);block++){
      let slot=id.x*p.blocks+block;
      let guess=bitcast<vec4f>(moments[4u*p.blocks+slot]);
      let q=bitcast<vec4f>(moments[slot]);
      let fastS=regionS || inBinade(s,guess.x,q.z,q.w);let fastQ=regionQ || inBinade(sq,guess.y,0.,q.y);
      if(fastS && !regionS){s=applyDelta(s,moments[8u*p.blocks+slot]);}
      if(fastQ && !regionQ){sq=applyDelta(sq,moments[12u*p.blocks+slot]);}
      if(!fastS||!fastQ){
        for(var i=block*16u;i<min(p.count,(block+1u)*16u);i++){
          let v=at(id.x,i);
          if(!fastS){s=dadd(s,term(v,false));}
          if(!fastQ){sq=dadd(sq,term(v,true));}
        }
      }
    }
  }
  let stats=exactGroup(s,sq,f32(p.count));
  moments[statOffset()+id.x]=bitcast<vec4u>(vec4f(tods(unpackD(stats.xy)),tods(unpackD(stats.zw))));
  moments[statOffset()+4u+id.x]=stats;
}
@compute @workgroup_size(128)
fn activate(@builtin(global_invocation_id) id:vec3u){
  let i=id.x;if(i>=4u*p.count){return;}
  let c=i%p.channels;
  let group=c/(p.channels/4u);
  let stats=bitcast<vec4f>(moments[statOffset()+group]);
  let v=add(mul(mul(add(pair(z[i]),-stats.xy),stats.zw),pair(affine[c])),pair(affine[p.channels+c]));
  var f=v;
  if(v.x< -80.){
    // Evaluating exp(-abs(v)) in binary32 would lose its scale in this tail.
    z[i]=exactActivation(z[i],affine[c],affine[p.channels+c],moments[statOffset()+4u+group]);
    return;
  }
  if(v.x<=38.){
    let e=expNeg(select(-v,v,v.x<0.));
    f=div2(select(v,mul(v,e),v.x<0.),add(pair(1.),e));
  }
  if(nearFloatBoundary(f,v)){
    z[i]=exactActivation(z[i],affine[c],affine[p.channels+c],moments[statOffset()+4u+group]);
  }else{z[i]=f.x;}
}`;
export async function createArcNormalization(device, weights) {
  const usage = GPUBufferUsage;
  const shader = device.createShaderModule({label: 'EchoArc GroupNorm and SiLU', code: wgsl});
  const bindings = ['storage', 'storage', 'read-only-storage', 'read-only-storage', 'uniform'];
  const layout = device.createBindGroupLayout({
    entries: bindings.map((type, binding) => ({binding, visibility: GPUShaderStage.COMPUTE, buffer: {type}}))
  });
  const pipelineLayout = device.createPipelineLayout({bindGroupLayouts: [layout]});
  const stages = ['partial', 'prefix', 'transfers', 'regions', 'finish', 'activate'];
  const pipelines = await Promise.all(stages.map(entryPoint => device.createComputePipelineAsync({
    layout: pipelineLayout, compute: {module: shader, entryPoint}
  })));
  function upload(data, flags) {
    const buffer = device.createBuffer({size: data.byteLength, usage: flags | usage.COPY_DST});
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }
  const table = new Float32Array(512);
  for (let i = 0; i < 256; i++) {
    const value = 2 ** (i / 256);
    table[2*i] = value;
    table[2*i+1] = value - table[2*i];
  }
  const expTable = upload(table, usage.STORAGE);
  return async (name, {h, w, c, buffer}) => {
    const count = h*w*c/4, blocks = Math.ceil(count/16), regions = Math.ceil(blocks/32);
    const scratch = device.createBuffer({size: (16*blocks + 16*regions + 8)*16, usage: usage.STORAGE});
    const scale = weights[name+'.weight'].values, bias = weights[name+'.bias'].values;
    const affine = upload(new Float32Array([...scale, ...bias]), usage.STORAGE);
    const config = upload(new Uint32Array([c, count, blocks, 0xffffffff]), usage.UNIFORM);
    const buffers = [buffer, scratch, affine, expTable, config];
    const bind = device.createBindGroup({
      layout, entries: buffers.map((resourceBuffer, binding) => ({binding, resource: {buffer: resourceBuffer}}))
    });
    const sizes = [[blocks, 4], [4, 1], [blocks, 4], [regions, 4], [4, 1], [Math.ceil(4*count/128), 1]];
    return pass => {
      pass.setBindGroup(0, bind);
      for (let i = 0; i < pipelines.length; i++) {
        pass.setPipeline(pipelines[i]);
        pass.dispatchWorkgroups(sizes[i][0], sizes[i][1]);
      }
    };
  };
}
