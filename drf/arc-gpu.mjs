// Eigen multiplies a row of spatial positions by [input channel, output channel]
// weights at each kernel offset. Preserve its separate FP32 reductions before adding the bias.
function convolutionShader(inChannels, outChannels, kernel, dilation) {
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
    let sy = y + (ky - ${kernel >> 1}) * ${dilation};
    if (sy < 0 || sy >= i32(cfg.height)) { continue; }
    for (var kx = 0; kx < ${kernel}; kx++) {
      let dx = (kx - ${kernel >> 1}) * ${dilation}; let sx = x + dx;
      if (sx < 0 || sx >= i32(cfg.width)) { continue; }
      let base = (u32(sy) * cfg.width + u32(sx)) * ${inChannels}u;
      let weight = u32(ky * ${kernel} + kx) * ${inChannels}u * groups + channel;
      var even = ${value}(0); var c = 0u;
      ${packed ? `// Eigen uses two accumulators over complete groups of four spatial positions.
      if (x - max(0, -dx) < ((i32(cfg.width) - abs(dx)) / 4) * 4) {
        var odd = ${value}(0);
        for (; c < ${inChannels - inChannels % 8}u; c += 2u) {
          even = rounded(even + rounded(image[base + c] * weights[weight + c * groups]));
          odd = rounded(odd + rounded(image[base + c + 1u] * weights[weight + (c + 1u) * groups]));
        }
        even = rounded(even + odd);
      }` : ''}
      for (; c < ${inChannels}u; c++) {
        even = rounded(even + rounded(image[base + c] * weights[weight + c * groups]));
      }
      outputValue = rounded(outputValue + even);
    }
  }
  result[gid.x] = outputValue;
}`;
}

export async function createArcGpu(runtime) {
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
    let completedCalls = 0, lost = false;
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
      layers.set(name,{inc,out,dilation,bindGroup,pipeline: await pipelines.get(code)});
    }));
    const {vendor='',architecture='',device: id='',description=''} = adapter.info ?? {};
    const backend = {
      adapterInfo: {vendor,architecture,device:id,description},
      get completedCalls() { return completedCalls; },
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
    return backend;
  } catch {
    device?.destroy();
    return null;
  }
}
