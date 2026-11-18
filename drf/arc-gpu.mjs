import { createArcNormalization } from './arc-gpu-norm.mjs?v=20261117-arc-resident';

// Eigen multiplies a row of spatial positions by [input channel, output channel]
// weights at each kernel offset. Preserve its separate FP32 reductions before adding the bias.
export function convolutionShader(inChannels, outChannels, kernel, dilation, broadcast = false, dilationY = dilation) {
  const sample=c=>broadcast?'cellValue':`image[base + ${c}]`;
  const packed = outChannels !== 1;
  const value = packed ? 'vec4f' : 'f32', bits = packed ? 'vec4u' : 'u32';
  return `
struct Params { width: u32, height: u32, roundMask: u32, unused: u32 }
@group(0) @binding(0) var<storage,read> image: array<f32>;
@group(0) @binding(1) var<storage,read> weights: array<${value}>;
@group(0) @binding(2) var<storage,read> biases: array<${value}>;
@group(0) @binding(3) var<storage,read_write> result: array<${value}>;
@group(0) @binding(4) var<uniform> cfg: Params;

// The runtime all-ones mask forces a rounded value to be materialized. A plain
// a*b+c (or a redundant bitcast alone) can contract into an FMA in Metal.
fn rounded(v: ${value}) -> ${value} {
  return bitcast<${value}>(bitcast<${bits}>(v) & ${bits}(cfg.roundMask));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let groups = ${packed ? outChannels / 4 : 1}u;
  let pixel = gid.x / groups;
  if (pixel >= cfg.width * cfg.height) { return; }
  let x = i32(pixel % cfg.width); let y = i32(pixel / cfg.width);
  let channel = gid.x % groups;
  var outputValue = biases[channel];
  for (var ky = 0; ky < ${kernel}; ky++) {
    let sy = y + (ky - ${kernel >> 1}) * ${dilationY};
    if (sy < 0 || sy >= i32(cfg.height)) { continue; }
    for (var kx = 0; kx < ${kernel}; kx++) {
      let dx = (kx - ${kernel >> 1}) * ${dilation}; let sx = x + dx;
      if (sx < 0 || sx >= i32(cfg.width)) { continue; }
      ${broadcast?'let cellValue = image[u32(sy) * cfg.width + u32(sx)];':
        `let base = (u32(sy) * cfg.width + u32(sx)) * ${inChannels}u;`}
      let weight = u32(ky * ${kernel} + kx) * ${inChannels}u * groups + channel;
      var even = ${value}(0); var c = 0u;
      ${packed ? `// Eigen uses two accumulators over complete groups of four spatial positions.
      if (x - max(0, -dx) < ((i32(cfg.width) - abs(dx)) / 4) * 4) {
        var odd = ${value}(0);
        for (; c < ${inChannels - inChannels % 8}u; c += 2u) {
          even = rounded(even + rounded(${sample('c')} * weights[weight + c * groups]));
          odd = rounded(odd + rounded(${sample('c + 1u')} * weights[weight + (c + 1u) * groups]));
        }
        even = rounded(even + odd);
      }` : ''}
      for (; c < ${inChannels}u; c++) {
        even = rounded(even + rounded(${sample('c')} * weights[weight + c * groups]));
      }
      outputValue = rounded(outputValue + even);
    }
  }
  result[gid.x] = outputValue;
}`;
}

// Four binary32 values are summed in JS binary64 before the one float32 store.
const strictPoolSum = `
fn roundValue(v: f32) -> f32 { return bitcast<f32>(bitcast<u32>(v) & params.z); }
fn addValue(acc: vec2f, v: f32) -> vec2f {
  let sum = roundValue(acc.x + v);
  let z = roundValue(sum - acc.x);
  let error = roundValue(roundValue(acc.x - roundValue(sum - z)) + roundValue(v - z));
  return vec2f(sum,roundValue(acc.y + error));
}`;

// Each GPU column stores its count followed by (row, lower, centre, upper) in row order.
// A column with more peaks triggers a full-logit readback, including every tied plateau.
export const arcPeakCapacity=4;
function peakShader(w,h,threshold){
  const limit=Math.log(threshold/(1-threshold)),f32=new Float32Array([limit]),bits=new Uint32Array(f32.buffer);
  // The original threshold comparison promotes the binary32 logit to binary64.
  if(f32[0]<limit)bits[0]+=f32[0]<0?-1:1;
  return `
@group(0) @binding(0) var<storage,read> image: array<f32>;
@group(0) @binding(1) var<storage,read_write> peaks: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let x=gid.x;
  if(x>=${w}u){return;}
  let start=x*${1+4*arcPeakCapacity}u;
  var n=0u;
  for(var y=1u;y<${h-1}u;y++){
    let i=y*${w}u+x;
    let z=image[i]; let lo=image[i-${w}u]; let hi=image[i+${w}u];
    if(z<bitcast<f32>(0x${bits[0].toString(16)}u)||z<lo||z<hi){continue;}
    if(y>=2u && z<image[i-${2*w}u]){continue;}
    if(y+2u<${h}u && z<image[i+${2*w}u]){continue;}
    if(n==${arcPeakCapacity}u){n++;break;}
    let base=start+1u+4u*n;
    peaks[base]=f32(y); peaks[base+1u]=lo; peaks[base+2u]=z; peaks[base+3u]=hi;
    n++;
  }
  peaks[start]=f32(n);
}`;
}

// The training transform produces one normalized scalar repeated across the nine channels.
async function residentNetwork(device,runtime,layers,layout,pipelineLayout,input,readback) {
  const usage=GPUBufferUsage,commands=[];
  const tensor=(h,w,c)=>({h,w,c,buffer:device.createBuffer({size:h*w*c*4,usage:usage.STORAGE|usage.COPY_SRC})});
  const bind=(layout,buffers)=>device.createBindGroup({layout,entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});
  function params(w,h){
    const b=device.createBuffer({size:16,usage:usage.UNIFORM|usage.COPY_DST});
    device.queue.writeBuffer(b,0,new Uint32Array([w,h,0xffffffff,0]));
    return b;
  }
  function dispatch(pipeline,group,n) {
    commands.push(pass=>{pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(n/64));});
  }
  const first=layers.get('e0.0');
  const firstModule=device.createShaderModule({label:'EchoArc broadcast input',code:convolutionShader(first.inc,first.out,first.k,first.dilation,true)});
  const firstPipeline=await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module:firstModule,entryPoint:'main'}});
  function conv(v,name){
    const layer=layers.get(name), out=tensor(v.h,v.w,layer.out);
    dispatch(name==='e0.0'?firstPipeline:layer.pipeline,bind(layout,[v.buffer,layer.weights,layer.bias,out.buffer,params(v.w,v.h)]),
      out.h*out.w*(layer.out===1?1:layer.out/4));
    return out;
  }
  const norm=await createArcNormalization(device,runtime.weights);
  async function block(v,name){
    for (const i of [0,3]) {
      v=conv(v,name+'.'+i);
      commands.push(await norm(name+'.'+(i+1),v));
    }
    return v;
  }
  async function reshape(v,skip){
    const pool=!skip, out=pool?tensor(v.h>>1,v.w>>1,v.c):tensor(skip.h,skip.w,skip.c+v.c);
    const code=`
@group(0) @binding(0) var<storage,read> a: array<f32>;
@group(0) @binding(1) var<storage,read_write> outputImage: array<f32>;
${pool?'@group(0) @binding(2) var<uniform> params: vec4u;':'@group(0) @binding(2) var<storage,read> skip: array<f32>;'}
${pool?strictPoolSum:''}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i=gid.x;
  if(i>=${out.h*out.w*out.c}u){return;}
  let pixel=i/${out.c}u; let x=pixel%${out.w}u; let y=pixel/${out.w}u;
  let c=i%${out.c}u;
  ${pool?`let off=(2u*y*${v.w}u+2u*x)*${v.c}u+c;
  var s=vec2f(a[off],0.);
  s=addValue(s,a[off+${v.c}u]);
  s=addValue(s,a[off+${v.w*v.c}u]);
  s=addValue(s,a[off+${(v.w+1)*v.c}u]);
  outputImage[i]=roundValue(s.x+s.y)*0.25;`:
  `if(c<${skip.c}u){outputImage[i]=skip[pixel*${skip.c}u+c];}
  else {let src=(y*${v.h}u/${out.h}u)*${v.w}u+x*${v.w}u/${out.w}u;
    outputImage[i]=a[src*${v.c}u+c-${skip.c}u];}`}
}`;
    const module=device.createShaderModule({code,label:pool?'EchoArc 2x2 pooling':'EchoArc skip concatenation'});
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    dispatch(pipeline,bind(pipeline.getBindGroupLayout(0),[v.buffer,out.buffer,pool?params(v.w,v.h):skip.buffer]),out.h*out.w*out.c);
    return out;
  }
  const a=await block({h:144,w:201,c:9,buffer:input},'e0');
  const b=await block(await reshape(a),'e1');
  const c=await block(await reshape(b),'b');
  const d=await block(await reshape(c,b),'d1');
  const e=await block(await reshape(d,a),'d0');
  const logits=conv(e,'out'),size=logits.h*logits.w*4;
  const stride=1+4*arcPeakCapacity,peaks=tensor(1,logits.w,stride),peakBytes=logits.w*stride*4;
  const module=device.createShaderModule({label:'EchoArc wall peaks',code:peakShader(logits.w,logits.h,runtime.data.threshold)});
  const peakPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  const peakGroup=bind(peakPipeline.getBindGroupLayout(0),[logits.buffer,peaks.buffer]);
  async function read(encoder,src,n){
    encoder.copyBufferToBuffer(src,0,readback,0,n);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ,0,n);
    try{return new Float32Array(readback.getMappedRange(0,n)).slice();}
    finally{readback.unmap();}
  }
  return async (values,full=false)=>{
    device.queue.writeBuffer(input,0,values);
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
    for(const encode of commands)encode(pass);
    if(!full){
      pass.setPipeline(peakPipeline);pass.setBindGroup(0,peakGroup);pass.dispatchWorkgroups(Math.ceil(logits.w/64));
    }
    pass.end();
    if(full)return read(encoder,logits.buffer,size);
    const packet=await read(encoder,peaks.buffer,peakBytes);
    for(let x=0;x<logits.w;x++)if(packet[x*stride]>arcPeakCapacity)return read(device.createCommandEncoder(),logits.buffer,size);
    return packet;
  };
}

export async function createArcGpu(runtime, referenceLogits) {
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) return null;
  let device;
  try {
    const adapter = await gpu.requestAdapter({powerPreference: 'high-performance'});
    if (!adapter || adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter) return null;
    device = await adapter.requestDevice({label: 'EchoArc-CNN'});
    const usage = GPUBufferUsage;
    // The largest activation is the 201 x 144 x 32 final decoder input.
    const bytes = 201 * 144 * 32 * 4;
    const buffer = (size, flags) => device.createBuffer({size, usage: flags});
    const input = buffer(bytes, usage.STORAGE | usage.COPY_DST);
    const output = buffer(bytes, usage.STORAGE | usage.COPY_SRC);
    const readback = buffer(bytes, usage.MAP_READ | usage.COPY_DST);
    const params = buffer(16, usage.UNIFORM | usage.COPY_DST);
    const layout = device.createBindGroupLayout({entries:
      ['read-only-storage','read-only-storage','read-only-storage','storage','uniform']
        .map((type,binding) => ({binding,visibility: GPUShaderStage.COMPUTE,buffer:{type}}))});
    const pipelineLayout = device.createPipelineLayout({bindGroupLayouts:[layout]});
    const pipelines = new Map(), layers = new Map();
    let completedCalls = 0, completedNetworks = 0, overflowReadbacks = 0, inputBytes = 0, outputBytes = 0, lost = false;
    device.lost.then(() => { lost = true; });
    function frozen(array) {
      const b = buffer(array.byteLength, usage.STORAGE | usage.COPY_DST);
      device.queue.writeBuffer(b,0,array);
      return b;
    }
    await Promise.all(Object.entries(runtime.weights).filter(([,w]) => w.shape.length === 4).map(async ([key,w]) => {
      const name = key.slice(0,-'.weight'.length);
      const [k,,inc,out] = w.shape, dilation = name === 'b.0' ? 2 : 1;
      const code = convolutionShader(inc,out,k,dilation);
      if (!pipelines.has(code)) {
        const module = device.createShaderModule({label: name,code});
        pipelines.set(code,device.createComputePipelineAsync({layout: pipelineLayout,compute:{module,entryPoint:'main'}}));
      }
      const buffers = [input,frozen(w.values),frozen(runtime.weights[name+'.bias'].values),output,params];
      const bindGroup = device.createBindGroup({layout,entries: buffers.map((b,binding) => ({binding,resource:{buffer:b}}))});
      layers.set(name,{inc,out,k,dilation,weights:buffers[1],bias:buffers[2],bindGroup,pipeline: await pipelines.get(code)});
    }));
    const {vendor='',architecture='',device: id='',description=''} = adapter.info ?? {};
    const backend = {
      adapterInfo: {vendor,architecture,device:id,description},
      get completedCalls() { return completedCalls; },
      get completedReadbacks() { return completedCalls-10*completedNetworks+overflowReadbacks; },
      get overflowReadbacks() { return overflowReadbacks; },
      get inputBytes() { return inputBytes; },
      get outputBytes() { return outputBytes; },
      get completedNetworks() { return completedNetworks; },
      destroy() { device.destroy(); },
      async convolution(v,name,dilation=1) {
        const layer = layers.get(name), size = v.h * v.w * layer.out * 4;
        if (lost || v.c !== layer.inc || dilation !== layer.dilation || size > bytes || v.data.byteLength > bytes)
          throw new Error('Unavailable EchoArc GPU convolution');
        device.queue.writeBuffer(input,0,v.data);
        device.queue.writeBuffer(params,0,new Uint32Array([v.w,v.h,0xffffffff,0]));
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(layer.pipeline); pass.setBindGroup(0,layer.bindGroup);
        pass.dispatchWorkgroups(Math.ceil(v.h * v.w * (layer.out === 1 ? 1 : layer.out / 4) / 64));
        pass.end();
        encoder.copyBufferToBuffer(output,0,readback,0,size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ,0,size);
        try {
          const data = new Float32Array(readback.getMappedRange(0,size)).slice();
          completedCalls++;
          return {data,h:v.h,w:v.w,c:layer.out};
        } finally { readback.unmap(); }
      },
    };
    // A device that contracts or rearranges the sums must keep using the WASM estimator.
    // Width 37 exercises both Eigen's four-position panels and its scalar tail.
    for (const [name,layer] of layers) {
      const h = 5, w = 37, c = layer.inc;
      const data = Float32Array.from({length:h*w*c}, (_,i) => Math.sin(i*.3745)*2.4);
      const weight = runtime.weights[name+'.weight'], bias = runtime.weights[name+'.bias'];
      const expected = runtime.call('convolution',[data,weight.values,bias.values],h*w*layer.out,
        [h,w,c,layer.out,weight.shape[0],layer.dilation]);
      const actual = await backend.convolution({h,w,c,data},name,layer.dilation);
      if (!expected.every((value,i) => Object.is(value,actual.data[i])))
        throw new Error('GPU did not reproduce the EchoArc FP32 convolution');
    }
    completedCalls = 0;
    try {
      if (!referenceLogits) return backend;
      const run = await residentNetwork(device,runtime,layers,layout,pipelineLayout,input,readback);
      // Every shipping backend must reproduce the frozen model on a nonzero, sparse
      // input before accepting live snapshots. Calibration is outside estimator timing.
      const plane=new Float32Array(144*201), probe = new Float32Array(plane.length*9);
      for (let x=0;x<201;x++) {
        const y=60+Math.floor(15*Math.sin(x*.08)), i=(y*201+x)*9;
        plane[i/9]=Math.fround(.25+(x%23)/31);probe.fill(plane[i/9],i,i+9);
      }
      const expected=referenceLogits(probe), actual=await run(plane,true);
      if (!expected.every((value,i)=>Object.is(value,actual[i]))) return backend;
      backend.compact = true;
      backend.network = async values=>{
        if(lost)throw new Error('EchoArc GPU device lost');
        const packet=await run(values);
        completedCalls+=11;completedNetworks++;
        inputBytes+=values.byteLength;
        outputBytes+=201*(1+4*arcPeakCapacity)*4;
        if(packet.length===144*201){overflowReadbacks++;outputBytes+=packet.byteLength;}
        return packet;
      };
    } catch {
      // Keep the calibrated per-layer backend when a resident pipeline is unsupported.
    }
    return backend;
  } catch {
    device?.destroy();
    return null;
  }
}
