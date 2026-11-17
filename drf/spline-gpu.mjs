// EchoSpline stationary-point screening. Each set bit asks the existing binary64
// fitter to check one horizontal sample for one observed Tx/Rx pair.
const code = `
struct Config { size:u32, rows:u32, words:u32, tolerance:f32 }
@group(0) @binding(0) var<storage,read> x:array<f32>;
@group(0) @binding(1) var<storage,read> y:array<f32>;
@group(0) @binding(2) var<storage,read> pairs:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> result:array<u32>;
@group(0) @binding(4) var<uniform> cfg:Config;
var<workgroup> lengths:array<f32,66>;
var<workgroup> flags:array<atomic<u32>,2>;
fn ray(j:u32, profile:u32, p:vec4f)->f32 {
  let q=vec2f(x[j],y[profile*cfg.size+j]); let a=q-p.xy; let b=q-p.zw;
  return sqrt(dot(a,a))+sqrt(dot(b,b));
}
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) id:vec3u,@builtin(local_invocation_index) k:u32) {
  let base=id.x*64u; let j=base+k; let last=cfg.size-1u;
  let p=pairs[id.y];
  lengths[k+1u]=ray(min(j,last),id.z,p);
  if(k<2u){
    atomicStore(&flags[k],0u);
    let off=select(min(base+64u,last),max(base,1u)-1u,k==0u);
    lengths[k*65u]=ray(off,id.z,p);
  }
  workgroupBarrier();
  if(j>0u && j<last){
    let l=lengths[k+1u]-lengths[k]; let r=lengths[k+2u]-lengths[k+1u];
    // Discard only when both adjacent differences have the same certified sign.
    if(!((l>cfg.tolerance && r>cfg.tolerance)||(l< -cfg.tolerance && r< -cfg.tolerance))){
      atomicOr(&flags[k/32u],1u<<(k%32u));
    }
  }
  workgroupBarrier();
  let word=id.x*2u+k;
  if(k<2u && word<cfg.words){result[(id.z*cfg.rows+id.y)*cfg.words+word]=atomicLoad(&flags[k]);}
}`;

function magnitude(values,max=1){
  for(const v of values)max=Math.max(max,Math.abs(v));
  return max;
}

export async function createSplineGpu() {
  const gpu=globalThis.navigator?.gpu;
  if(!gpu)return null;
  let device;
  try {
    const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter || adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter)return null;
    device=await adapter.requestDevice({label:'EchoSpline stationary-point screening'});
    const shader=device.createShaderModule({label:'EchoSpline conservative range extrema',code});
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:shader,entryPoint:'main'}});
    const u=GPUBufferUsage;
    const config=device.createBuffer({size:16,usage:u.UNIFORM|u.COPY_DST});
    const cfg=new Uint32Array(4),cfgFloat=new Float32Array(cfg.buffer);
    let state,completedCalls=0,busy=false,lost=false;
    device.lost.then(()=>{lost=true;});
    function checked(task){
      // Validation and allocation failures can be reported without throwing in WebGPU.
      for(const filter of ['validation','out-of-memory','internal'])device.pushErrorScope(filter);
      let errors;
      try{task();}
      finally{errors=Promise.all([device.popErrorScope(),device.popErrorScope(),device.popErrorScope()])
        .then(items=>items.some(Boolean),()=>true);}
      return errors;
    }
    function release(){if(state)for(const b of state.buffers)b.destroy();state=undefined;}
    function allocate(grid,rows,words){
      release();
      const capacity=Math.min(device.limits.maxComputeWorkgroupsPerDimension,2**Math.ceil(Math.log2(rows)));
      const bytes=capacity*words*4*4;
      if(bytes>device.limits.maxStorageBufferBindingSize || bytes>device.limits.maxBufferSize ||
         capacity*16>device.limits.maxStorageBufferBindingSize || grid.length*16>device.limits.maxStorageBufferBindingSize)return;
      const buffer=(size,usage)=>device.createBuffer({size,usage});
      const buffers=[buffer(grid.length*4,u.STORAGE|u.COPY_DST),buffer(grid.length*4*4,u.STORAGE|u.COPY_DST),
        buffer(capacity*16,u.STORAGE|u.COPY_DST),buffer(bytes,u.STORAGE|u.COPY_SRC),buffer(bytes,u.COPY_DST|u.MAP_READ)];
      device.queue.writeBuffer(buffers[0],0,new Float32Array(grid));
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...buffers.slice(0,4),config]
        .map((b,binding)=>({binding,resource:{buffer:b}}))});
      state={grid,capacity,buffers,group,rows:0,max:magnitude(grid)};
    }
    function bind(grid,observations){
      const rows=observations.length,words=Math.ceil(grid.length/32);
      if(lost || busy || !rows || grid.length<3 || rows>device.limits.maxComputeWorkgroupsPerDimension ||
         Math.ceil(grid.length/64)>device.limits.maxComputeWorkgroupsPerDimension)return null;
      const preparationFailed=checked(()=>{
        if(!state || state.grid!==grid || state.capacity<rows)allocate(grid,rows,words);
        if(!state)return null;
        if(state.source!==observations || rows<state.rows || (state.rows && observations[state.rows-1]!==state.last)){
          state.rows=0;state.source=observations;state.max=magnitude(grid);
        }
        if(rows>state.rows){
          const positions=new Float32Array(4*(rows-state.rows));let k=0;
          for(let i=state.rows;i<rows;i++){
            const {a,b}=observations[i];
            for(const v of [a[0],a[1],b[0],b[1]]){state.max=Math.max(state.max,Math.abs(v));positions[k++]=v;}
          }
          device.queue.writeBuffer(state.buffers[2],state.rows*16,positions);state.rows=rows;state.last=observations[rows-1];
        }
      });
      if(!state)return null;
      const cache=state,bytes=4*words*rows;
      async function submit(profiles){
        if(lost || busy || cache!==state || cache.source!==observations || !profiles.length || profiles.length>4 || profiles.some(h=>h.length!==grid.length))return null;
        let max=cache.max;for(const h of profiles)max=magnitude(h,max);
        // At |coordinate|<=M, rounding positions and subtracting costs <=4uM
        // per component. Two Euclidean norms, their addition, and differencing
        // adjacent lengths stay within 128uM (u=2^-24, WGSL sqrt <=2 ULP).
        // M>=1 also covers subnormal flushes. Outside this range the CPU scans.
        if(!(max<=1e15))return null;
        const [ ,heightBuffer, ,output,readback]=cache.buffers;
        busy=true;
        try{
          const dispatchFailed=checked(()=>{
            cfg[0]=grid.length;cfg[1]=rows;cfg[2]=words;cfgFloat[3]=max*2**-17;
            device.queue.writeBuffer(config,0,cfg);
            const ys=new Float32Array(grid.length*profiles.length);
            for(let i=0;i<profiles.length;i++)ys.set(profiles[i],i*grid.length);
            device.queue.writeBuffer(heightBuffer,0,ys);
            const encoder=device.createCommandEncoder(), pass=encoder.beginComputePass();
            pass.setPipeline(pipeline);pass.setBindGroup(0,cache.group);
            pass.dispatchWorkgroups(Math.ceil(grid.length/64),rows,profiles.length);pass.end();
            encoder.copyBufferToBuffer(output,0,readback,0,bytes*profiles.length);device.queue.submit([encoder.finish()]);
          });
          await readback.mapAsync(GPUMapMode.READ,0,bytes*profiles.length);
          try{
            if(lost || (await preparationFailed) || (await dispatchFailed))throw Error('EchoSpline GPU screening failed');
            const mask=new Uint32Array(readback.getMappedRange(0,bytes*profiles.length)).slice();completedCalls++;
            return profiles.map((_,i)=>mask.subarray(i*words*rows,(i+1)*words*rows));}
          finally{readback.unmap();}
        }finally{busy=false;}
      }
      const single=async heights=>(await submit([heights]))?.[0]??null;
      single.batch=async profiles=>await submit(profiles)??profiles.map(()=>null);
      return single;
    }
    const adapterInfo=Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,adapter.info?.[k]??'']));
    const grid=Float64Array.from({length:99},(_,i)=>i/8),obs=[{a:[0,1],b:[9,-2]},{a:[3,2],b:[8,3]}];
    const profiles=[grid.map((x,i)=>3+Math.cos(x)+.03*(i%3)),grid.map(()=>3),
      grid.map((x,i)=>i%2?2.5:4),grid.map(x=>3+1e-8*Math.cos(x))];
    const masks=await bind(grid,obs).batch(profiles);
    for(let profile=0;profile<profiles.length;profile++){
      const y=profiles[profile],mask=masks[profile];
      if(!mask || mask.length!==8)throw Error('EchoSpline GPU calibration failed');
      for(const [i,{a,b}] of obs.entries()){
        const lens=grid.map((x,j)=>Math.sqrt((x-a[0])**2+(y[j]-a[1])**2)+Math.sqrt((x-b[0])**2+(y[j]-b[1])**2));
        for(let j=1;j+1<grid.length;j++)if((lens[j]-lens[j-1])*(lens[j+1]-lens[j])<=0 &&
          !(mask[4*i+(j>>5)]&(1<<(j%32))))throw Error('EchoSpline GPU mask missed a range extremum');
      }
    }
    release();completedCalls=0;
    return {bind,adapterInfo,get completedCalls(){return completedCalls;},destroy(){lost=true;device.destroy();}};
  }catch{device?.destroy();return null;}
}
