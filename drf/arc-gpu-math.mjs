// WGSL has no f64 type. Preserve JavaScript's binary64 rounding in the four
// group statistics and in the small set of activations near a float32 midpoint.
function f64(x) {
  const d = new DataView(new ArrayBuffer(8));
  d.setFloat64(0,x,true);
  return 'vec2u(0x'+d.getUint32(0,true).toString(16)+'u,0x'+d.getUint32(4,true).toString(16)+'u)';
}

// On |x| <= ln(2)/2 the first omitted Taylor term is below 5e-23.
let factorial=1;
const coefficients=Array.from({length:17},(_,k)=>{
  factorial*=k||1;
  return 'unpackD('+f64(1/factorial)+')';
});
const expCoefficients=['var tail='+coefficients[16]+';',
  ...coefficients.slice(2,16).reverse().map(c=>'tail=dadd('+c+',dmul(frac,tail));'),
  'let expFrac=dadd(term(1.,false),dadd(frac,dmul(dmul(frac,frac),tail)));'].join('\n');
export const exactArcMath = `
// Binary64 operands stay in D (53-bit significand) throughout the rare rounding check.
fn dz(a:D)->bool {return all(a.m==vec2u(0));}
fn flip(a:D)->D{return D(a.m,a.e,!a.neg);}
fn dlt(a:vec2u,b:vec2u)->bool{return a.y<b.y || (a.y==b.y&&a.x<b.x);}
fn roundD(m0:vec2u,e0:i32,neg:bool,up:bool)->D{
  var m=m0;var e=e0;
  if(up){m=plus(m,vec2u(1,0));if(m.y>=0x200000u){m=shr(m,1u);e++;}}
  return D(m,e,neg);
}
fn dmul(a:D,b:D)->D {
  if(dz(a)||dz(b)){return D(vec2u(0),0,false);}
  let x=vec4u(a.m.x&65535u,a.m.x>>16u,a.m.y&65535u,a.m.y>>16u);
  let y=vec4u(b.m.x&65535u,b.m.x>>16u,b.m.y&65535u,b.m.y>>16u);
  var t:array<u32,8>;
  for(var i=0u;i<4u;i++){
    var carry=0u;
    for(var j=0u;j<4u;j++){
      let k=i+j;
      let z=x[i]*y[j]+t[k]+carry;
      t[k]=z&65535u;carry=z>>16u;
    }t[i+4u]=carry;
  }
  // The full product has 105 or 106 significant bits.
  let top=t[6];let shift=select(4u,5u,top>=512u);
  let hi=vec2u(t[3]|(t[4]<<16u),t[5]|(t[6]<<16u));
  let m=shr(hi,shift);
  let halfway=1u<<(shift-1u);let tail=hi.x&((1u<<shift)-1u);
  let up=tail>halfway || (tail==halfway&&((m.x&1u)!=0u||(t[0]|t[1]|t[2])!=0u));
  return roundD(m,a.e+b.e+i32(shift)-4,a.neg!=b.neg,up);
}
fn ddiv(a:D,b:D)->D{
  if(dz(a)){return a;}
  var r=a.m;var e=a.e-b.e;
  if(dlt(r,b.m)){r=shl(r,1u);e--;}
  r=minus(r,b.m);var q=vec2u(1,0);
  for(var k=0u;k<52u;k++){q=shl(q,1u);r=shl(r,1u);if(!dlt(r,b.m)){q.x|=1u;r=minus(r,b.m);}}
  let rem=shl(r,1u);
  return roundD(q,e,a.neg!=b.neg,dlt(b.m,rem)||(all(rem==b.m)&&(q.x&1u)!=0u));
}
fn dsqrt(a:D)->D{
  if(dz(a)){return a;}
  // Digit-by-digit root of m << 52 (or 53 for an odd exponent).
  let shift=52u+(u32(a.e)&1u);var q=vec2u(0);var rem=vec2u(0);
  for(var k=52;k>=0;k--){
    var next=0u;
    for(var j=0u;j<2u;j++){
      let at=u32(2*k)+j;
      if(at>=shift){let bit=at-shift;next|=((select(a.m.x,a.m.y,bit>=32u)>>(bit&31u))&1u)<<j;}
    }
    rem=shl(rem,2u);rem.x|=next;
    var trial=shl(q,2u);trial.x|=1u;q=shl(q,1u);
    if(!dlt(rem,trial)){rem=minus(rem,trial);q.x|=1u;}
  }
  return roundD(q,a.e>>1,false,dlt(q,rem));
}
fn packedD(a:D)->vec2u{
  if(dz(a)){return vec2u(0);}
  return vec2u(a.m.x,(a.m.y&0xfffffu)|(u32(a.e+1023)<<20u)|(u32(a.neg)<<31u));
}
fn unpackD(v:vec2u)->D{
  if((v.y&0x7fffffffu)==0u && v.x==0u){return D(vec2u(0),0,false);}
  return D(vec2u(v.x,(v.y&0xfffffu)|0x100000u),i32((v.y>>20u)&2047u)-1023,(v.y>>31u)!=0u);
}
fn dtoFloat(a:D)->f32{
  if(dz(a)){return 0.;}
  var bits=(a.m.y<<3u)|(a.m.x>>29u);
  let tail=a.m.x&0x1fffffffu;
  if(tail>0x10000000u || (tail==0x10000000u&&(bits&1u)!=0u)){bits++;}
  return ldexp(select(1.,-1.,a.neg)*f32(bits),a.e-23);
}
fn exactGroup(s:D,sq:D,n:f32)->vec4u{
  let count=term(n,false);let mean=ddiv(s,count);
  let var0=dadd(ddiv(sq,count),flip(dmul(mean,mean)));
  var corrected=unpackD(${f64(1e-5)});
  if(!var0.neg){corrected=dadd(corrected,var0);}
  let inv=ddiv(term(1.,false),dsqrt(corrected));
  return vec4u(packedD(mean),packedD(inv));
}
// A power of two has unequal spacing on its two sides.
fn nearFloatBoundary(f:vec2f,v:vec2f)->bool {
  let b=bitcast<u32>(abs(f.x));
  let inward=(b&0x7fffffu)==0u && ((bitcast<u32>(f.x)^bitcast<u32>(f.y))>>31u)!=0u;
  let halfStep=ldexp(select(.5,.25,inward),i32((b>>23u)&255u)-127-23);
  return abs(abs(f.y)-halfStep)<4e-13*(1.+abs(v.x));
}
// Used only near an FP32 rounding midpoint. Ordinary activations stay in the fast shader.
fn exactActivation(x:f32,scale:f32,bias:f32,stats:vec4u)->f32{
  let v=dadd(dmul(dmul(dadd(term(x,false),flip(unpackD(stats.xy))),unpackD(stats.zw)),term(scale,false)),term(bias,false));
  // Reduce -v to [-ln(2)/2,ln(2)/2] and sum the exponential as a Taylor series.
  let neg=flip(v);let k=i32(round(-dtoFloat(v)*1.4426950408889634));
  let kd=term(f32(k),false);
  let frac=dadd(dadd(neg,flip(dmul(kd,unpackD(${f64(.6931471803691238)})))),flip(dmul(kd,unpackD(${f64(1.9082149292705877e-10)}))));
  ${expCoefficients}
  let e=D(expFrac.m,expFrac.e+k,false);
  return dtoFloat(ddiv(v,dadd(term(1.,false),e)));
}
`;
