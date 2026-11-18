const names=['gat.0.W','gat.1.W','gat.2.W','gat.3.W','mlp.0.weight','mlp.2.weight','mlp.4.weight'];

// Eigen 5.0.1 WASM uses scalar float packets: L1=16 KiB, mr=1, nr=4, K peeling=8.
export function gatDenseBlockSize(inc){
  const maximum=816;
  return inc<=maximum?inc:inc%maximum===0?maximum:
    maximum-8*Math.floor((maximum-1-inc%maximum)/(8*(Math.floor(inc/maximum)+1)));
}

export function gatDenseShader(inc,out){
  const gemm=gatDenseBlockSize(inc),gemv=inc<128?inc:out*4<32000?16:4;
  return `
struct Params { rows: u32, height: u32, roundMask: u32, unused: u32 }
@group(0) @binding(0) var<storage,read> image: array<f32>;
@group(0) @binding(1) var<storage,read> weights: array<vec4f>;
@group(0) @binding(2) var<storage,read> biases: array<vec4f>;
@group(0) @binding(3) var<storage,read_write> result: array<vec4f>;
@group(0) @binding(4) var<uniform> cfg: Params;
fn rounded(v: vec4f) -> vec4f {
  return bitcast<vec4f>(bitcast<vec4u>(v) & vec4u(cfg.roundMask));
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let groups=${out/4}u; let row=gid.x/groups;
  if(row>=cfg.rows){return;}
  let channel=gid.x%groups; let base=row*${inc}u;
  let block=select(${gemm}u,${gemv}u,cfg.rows==1u);
  var value=biases[channel];
  for(var start=0u;start<${inc}u;start+=block){
    let end=min(start+block,${inc}u); var k=start; var even=vec4f(0);
    if(cfg.rows>1u && row<(cfg.rows/4u)*4u){
      let peel=end-(end-start)%8u; var odd=vec4f(0);
      for(;k<peel;k+=2u){
        even=rounded(even+rounded(image[base+k]*weights[k*groups+channel]));
        odd=rounded(odd+rounded(image[base+k+1u]*weights[(k+1u)*groups+channel]));
      }
      even=rounded(even+odd);
    }
    for(;k<end;k++){even=rounded(even+rounded(image[base+k]*weights[k*groups+channel]));}
    value=rounded(value+even);
  }
  result[gid.x]=value;
}`;
}

// Dense input [rows,in], weights [in,out], output [rows,out] are row-major FP32.
// Attention/softmax and GP remain on the CPU; only these seven projections move.
// Each call uses O(rows*(in+out)) workspace and O(rows*in*out) arithmetic.
export function createGatGpu(runtime){
  const gpu=globalThis.navigator?.gpu;if(!gpu)return null;
  let device,layout,closed=false,failure,adapterInfo={},tail=Promise.resolve();
  let completedCalls=0,inputBytes=0,outputBytes=0;
  const owned=new Set(),layers=new Map();
  function available(){if(closed)throw failure??new Error('GAT GPU is closed');}
  function close(){
    if(closed)return;closed=true;
    for(const b of owned)b.destroy();owned.clear();device?.destroy();
  }
  function release(b){owned.delete(b);b.destroy();}
  function buffer(size,usage){
    available();
    if(size>device.limits.maxBufferSize||((usage&GPUBufferUsage.STORAGE)&&size>device.limits.maxStorageBufferBindingSize))
      throw new Error('GAT GPU buffer limit exceeded');
    const b=device.createBuffer({size,usage});owned.add(b);return b;
  }
  function frozen(data){
    const b=buffer(data.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(b,0,data);return b;
  }
  function workspace(layer,rows){
    if(layer.state?.rows===rows)return layer.state;
    if(layer.state){for(const b of layer.state.buffers)release(b);layer.state=undefined;}
    const buffers=[],make=(size,usage)=>{const b=buffer(size,usage);buffers.push(b);return b;};
    try{
      const input=make(rows*layer.inc*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
      const output=make(rows*layer.out*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
      const readback=make(rows*layer.out*4,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
      const params=make(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(params,0,new Uint32Array([rows,1,0xffffffff,0]));
      const group=device.createBindGroup({layout,entries:[input,layer.weights,layer.zero,output,params]
        .map((buffer,binding)=>({binding,resource:{buffer}}))});
      return layer.state={rows,input,output,readback,group,buffers};
    }catch(error){for(const b of buffers)release(b);throw error;}
  }
  async function multiply(input,name,rows){
    available();const layer=layers.get(name);
    if(!layer||!(input instanceof Float32Array)||!Number.isSafeInteger(rows)||rows<1||input.length!==rows*layer.inc)
      throw new Error('Invalid GAT GPU dense input');
    const workgroups=Math.ceil(rows*(layer.out/4)/64);
    if(workgroups>device.limits.maxComputeWorkgroupsPerDimension)throw new Error('GAT GPU dispatch limit exceeded');
    const state=workspace(layer,rows),bytes=rows*layer.out*4;
    device.queue.writeBuffer(state.input,0,input);
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
    pass.setPipeline(layer.pipeline);pass.setBindGroup(0,state.group);pass.dispatchWorkgroups(workgroups);pass.end();
    encoder.copyBufferToBuffer(state.output,0,state.readback,0,bytes);device.queue.submit([encoder.finish()]);
    await state.readback.mapAsync(GPUMapMode.READ,0,bytes);
    try{available();return new Float32Array(state.readback.getMappedRange(0,bytes)).slice();}
    finally{if(state.readback.mapState==='mapped')state.readback.unmap();}
  }
  async function initialize(){
    const adapter=await gpu.requestAdapter();available();
    if(!adapter||adapter.isFallbackAdapter||adapter.info?.isFallbackAdapter)throw new Error('No supported GAT GPU adapter');
    device=await adapter.requestDevice({label:'GAT dense projections'});
    if(closed){device.destroy();available();}
    device.lost.then(info=>{failure??=new Error(info.message||'GAT GPU device lost');close();});
    const {vendor='',architecture='',device:id='',description=''}=adapter.info??{};
    adapterInfo={vendor,architecture,device:id,description};
    layout=device.createBindGroupLayout({entries:['read-only-storage','read-only-storage','read-only-storage','storage','uniform']
      .map((type,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type}}))});
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
    for(const name of names){
      const weight=runtime.weights[name],shape=weight?.shape;
      if(shape?.length!==2||!shape.every(n=>Number.isSafeInteger(n)&&n>0)||shape[1]%4||weight.values.length!==shape[0]*shape[1])
        throw new Error('Invalid GAT GPU weight '+name);
      const [inc,out]=shape,module=device.createShaderModule({label:name,code:gatDenseShader(inc,out)});
      const pipeline=await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint:'main'}});
      layers.set(name,{inc,out,pipeline,weights:frozen(weight.values),zero:frozen(new Float32Array(out))});
    }
    // Compare the actual dense WASM kernel, including full panels and all scalar tails.
    for(const name of names)for(const rows of [1,2,3,4,5,17,64,257,...(name.startsWith('gat.')?[1024,2049]:[])]){
      const weight=runtime.weights[name],input=Float32Array.from({length:rows*weight.shape[0]},(_,i)=>Math.sin(i*.3745)*2.4);
      const expected=runtime.call('multiply',[input,weight.values],rows*weight.shape[1],[rows,...weight.shape]);
      const actual=await multiply(input,name,rows);
      const first=expected.findIndex((v,i)=>!Object.is(v,actual[i]));
      if(first>=0){
        let maximum=0;for(let i=0;i<expected.length;i++)maximum=Math.max(maximum,Math.abs(expected[i]-actual[i]));
        throw new Error('GPU did not reproduce GAT FP32 layer '+name+' rows='+rows+' index='+first+
          ' expected='+expected[first]+' actual='+actual[first]+' maxError='+maximum);
      }
    }
    available();
  }
  const ready=initialize().catch(error=>{failure=error;close();throw error;});ready.catch(()=>{});
  return {
    ready,close,
    get closed(){return closed;},get adapterInfo(){return adapterInfo;},
    get completedCalls(){return completedCalls;},get completedReadbacks(){return completedCalls;},
    get inputBytes(){return inputBytes;},get outputBytes(){return outputBytes;},
    multiply(input,name,rows){
      const result=tail.then(async()=>{
        await ready;const output=await multiply(input,name,rows);
        completedCalls++;inputBytes+=input.byteLength;outputBytes+=output.byteLength;return output;
      });
      tail=result.catch(()=>{});return result;
    },
  };
}
