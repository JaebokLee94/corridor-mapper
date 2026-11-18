import {convolutionShader} from './arc-gpu.mjs?v=20261118-rugged-canonical';

const HEIGHT=81;
const originalDilations=[[1,2],[1,4],[2,8],[3,12]];

function activationShader(channels,residual) {
  return `
struct Params { width: u32, height: u32, roundMask: u32, unused: u32 }
@group(0) @binding(0) var<storage,read_write> image: array<f32>;
${residual?'@group(0) @binding(1) var<storage,read> update: array<f32>;':''}
@group(0) @binding(${residual?2:1}) var<uniform> cfg: Params;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i=gid.x;
  if(i>=cfg.width*cfg.height*${channels}u){return;}
  image[i]=${residual?'image[i]+max(0.,update[i])':'max(0.,image[i])'};
}`;
}

// NHWC input [81,N,inputChannels], one raw [81,N] logit readback per estimate.
// The caller subtracts the shared height prior. Inputs stay borrowed until resolve.
export function createSplineCnnGpu(runtime) {
  const gpu=globalThis.navigator?.gpu;
  if(!gpu)return null;
  let device,closed=false,lost=false,failure,resident,adapterInfo={};
  let completedCalls=0,inputBytes=0,outputBytes=0,tail=Promise.resolve();
  const owned=new Set(),layers=[],pipelines=new Map();
  const unavailable=()=>failure??new Error(lost?'EchoSpline GPU device lost':'EchoSpline GPU is closed');
  function available(){if(closed||lost)throw unavailable();}
  function release(buffer){owned.delete(buffer);buffer.destroy();}
  function close(){
    if(closed)return;
    closed=true;
    for(const buffer of owned)buffer.destroy();
    owned.clear();resident=undefined;device?.destroy();
  }
  function buffer(size,usage){
    available();
    if(size>device.limits.maxBufferSize)throw new Error('EchoSpline GPU buffer limit exceeded');
    const b=device.createBuffer({size,usage});owned.add(b);return b;
  }
  function frozen(values){
    const b=buffer(values.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(b,0,values);return b;
  }
  const bind=(layout,buffers)=>device.createBindGroup({layout,entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});
  function dispatch(pass,pipeline,group,count){
    const workgroups=Math.ceil(count/64);
    if(workgroups>device.limits.maxComputeWorkgroupsPerDimension)throw new Error('EchoSpline GPU dispatch limit exceeded');
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(workgroups);
  }
  async function read(encoder,source,readback,bytes){
    encoder.copyBufferToBuffer(source,0,readback,0,bytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ,0,bytes);
    try{available();return new Float32Array(readback.getMappedRange(0,bytes)).slice();}
    finally{if(readback.mapState==='mapped')readback.unmap();}
  }
  async function initialize(){
    // Use the browser's selected adapter; requesting a GPU is gated by the caller.
    const adapter=await gpu.requestAdapter();available();
    if(!adapter||adapter.isFallbackAdapter||adapter.info?.isFallbackAdapter)throw new Error('No supported EchoSpline GPU adapter');
    device=await adapter.requestDevice({label:'EchoSpline-CNN'});
    if(closed){device.destroy();throw unavailable();}
    device.lost.then(info=>{lost=true;failure??=new Error(info.message||'EchoSpline GPU device lost');close();});
    const {vendor='',architecture='',device:id='',description=''}=adapter.info??{};
    adapterInfo={vendor,architecture,device:id,description};
    const layout=device.createBindGroupLayout({entries:
      ['read-only-storage','read-only-storage','read-only-storage','storage','uniform']
        .map((type,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type}}))});
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
    const dilations=runtime.data.dilations??originalDilations;
    const definitions=[['start',1,1],...dilations.map(([dy,dx],i)=>['blocks.'+i,dy,dx]),['end',1,1]];
    const width=runtime.weights['start.weight'].shape[3],inputChannels=runtime.weights['start.weight'].shape[2];
    if(!Number.isSafeInteger(width)||width%4||width<4)throw new Error('Unsupported EchoSpline GPU width');
    for(const [name,dy,dx] of definitions){
      available();
      const weight=runtime.weights[name+'.weight'],bias=runtime.weights[name+'.bias'];
      if(!weight||!bias)throw new Error('Missing EchoSpline GPU layer '+name);
      const [k,kw,inc,out]=weight.shape;
      if(k!==kw||inc!==(name==='start'?inputChannels:width)||out!==(name==='end'?1:width)||
        !Number.isSafeInteger(dx)||!Number.isSafeInteger(dy)||dx<1||dy<1)
        throw new Error('Invalid EchoSpline GPU layer '+name);
      const code=convolutionShader(inc,out,k,dx,false,dy);
      if(!pipelines.has(code)){
        const module=device.createShaderModule({label:'EchoSpline '+name,code});
        pipelines.set(code,device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint:'main'}}));
      }
      layers.push({name,dy,dx,k,inc,out,weights:frozen(weight.values),bias:frozen(bias.values),pipeline:await pipelines.get(code)});
    }
    available();
    const activation=await Promise.all([false,true].map(residual=>{
      const module=device.createShaderModule({label:residual?'EchoSpline residual ReLU':'EchoSpline initial ReLU',code:activationShader(width,residual)});
      return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    }));
    // Exercise vector panels, scalar tails and both noncentral taps of the
    // largest XY dilation before accepting any live estimate.
    const h=2*Math.max(...layers.map(l=>l.dy))+5,w=Math.max(37,2*Math.max(...layers.map(l=>l.dx))+5);
    const maxChannels=Math.max(width,inputChannels),size=h*w*maxChannels*4;
    const probeInput=buffer(size,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    const probeOutput=buffer(size,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
    const probeReadback=buffer(size,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
    const probeParams=buffer(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(probeParams,0,new Uint32Array([w,h,0xffffffff,0]));
    try{
      for(const layer of layers){
        available();
        const data=Float32Array.from({length:h*w*layer.inc},(_,i)=>Math.sin(i*.3745)*2.4);
        const weight=runtime.weights[layer.name+'.weight'],bias=runtime.weights[layer.name+'.bias'];
        const expected=runtime.call('convolutionXY',[data,weight.values,bias.values],h*w*layer.out,[h,w,layer.inc,layer.out,layer.k,layer.dy,layer.dx]);
        device.queue.writeBuffer(probeInput,0,data);
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        dispatch(pass,layer.pipeline,bind(layout,[probeInput,layer.weights,layer.bias,probeOutput,probeParams]),h*w*(layer.out===1?1:layer.out/4));pass.end();
        const actual=await read(encoder,probeOutput,probeReadback,h*w*layer.out*4);
        if(!expected.every((v,i)=>Object.is(v,actual[i])))throw new Error('GPU did not reproduce EchoSpline FP32 layer '+layer.name);
      }
    }finally{for(const b of [probeInput,probeOutput,probeReadback,probeParams])if(owned.has(b))release(b);}
    available();return {layout,activation,width,inputChannels};
  }
  const ready=initialize().catch(error=>{failure=error;close();throw error;});
  // A caller may close while adapter creation is pending and never await ready.
  ready.catch(()=>{});
  function workspace(n,configuration){
    if(resident?.n===n)return resident;
    if(resident){for(const b of resident.buffers)release(b);resident=undefined;}
    const {width,inputChannels,layout,activation}=configuration,cells=HEIGHT*n;
    const largest=cells*Math.max(width,inputChannels)*4;
    if(largest>device.limits.maxStorageBufferBindingSize)throw new Error('EchoSpline GPU storage limit exceeded');
    const buffers=[],make=(size,usage)=>{const b=buffer(size,usage);buffers.push(b);return b;};
    try{
      const input=make(cells*inputChannels*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
      const a=make(cells*width*4,GPUBufferUsage.STORAGE),b=make(cells*width*4,GPUBufferUsage.STORAGE);
      const logits=make(cells*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
      const readback=make(cells*4,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST),params=make(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(params,0,new Uint32Array([n,HEIGHT,0xffffffff,0]));
      const initial=bind(activation[0].getBindGroupLayout(0),[a,params]);
      const residual=bind(activation[1].getBindGroupLayout(0),[a,b,params]);
      const commands=[];
      for(const layer of layers){
        const group=bind(layout,[layer.name==='start'?input:a,layer.weights,layer.bias,layer.name==='end'?logits:layer.name==='start'?a:b,params]);
        commands.push(pass=>dispatch(pass,layer.pipeline,group,cells*(layer.out===1?1:layer.out/4)));
        if(layer.name!=='end')commands.push(pass=>dispatch(pass,activation[layer.name==='start'?0:1],layer.name==='start'?initial:residual,cells*width));
      }
      return resident={n,buffers,input,logits,readback,commands};
    }catch(error){for(const b of buffers)release(b);resident=undefined;throw error;}
  }
  return {
    ready,
    get adapterInfo(){return adapterInfo;},
    get completedCalls(){return completedCalls;},
    get completedReadbacks(){return completedCalls;},
    get inputBytes(){return inputBytes;},
    get outputBytes(){return outputBytes;},
    get closed(){return closed;},
    close,
    estimate(input,n){
      const result=tail.then(async()=>{
        const configuration=await ready;available();
        if(!(input instanceof Float32Array)||!Number.isSafeInteger(n)||n<1||input.length!==HEIGHT*n*configuration.inputChannels)
          throw new Error('Invalid EchoSpline GPU NHWC input');
        const state=workspace(n,configuration);
        device.queue.writeBuffer(state.input,0,input);
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        for(const command of state.commands)command(pass);pass.end();
        const logits=await read(encoder,state.logits,state.readback,HEIGHT*n*4);
        completedCalls++;inputBytes+=input.byteLength;outputBytes+=logits.byteLength;
        return logits;
      });
      tail=result.catch(()=>{});return result;
    },
  };
}
